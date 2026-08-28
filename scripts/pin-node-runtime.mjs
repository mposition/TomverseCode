/**
 * 동봉 Node 런타임의 **핀을 다시 잡는다** — `packages/toolchain/node-runtime.json`.
 *
 * ```bash
 * npm run node-runtime:pin -- --version v24.20.0          # 검증만 하고 출력
 * npm run node-runtime:pin -- --version v24.20.0 --write  # 핀 파일까지 고친다
 * ```
 *
 * # 왜 GPG가 **여기에만** 필요한가
 *
 * 서명이 보증하는 것은 "이 해시 목록이 Node 릴리스팀에서 왔다"이고, 그건 **핀을 넣는 시점에
 * 한 번 성립하면 계속 성립한다.** 해시가 저장소에 박힌 뒤로 빌드는 받은 바이트가 그 값과
 * 같은지만 보면 되므로 gpg가 필요 없다. 그래서 빌드 머신에는 gpg가 없어도 되고, 이 명령에는
 * 반드시 있어야 한다 — **없으면 실패한다.** "gpg가 없으니 건너뛴다"는 순간 이 명령이 하는
 * 일이 `curl | sha256sum`과 같아진다.
 *
 * # allowlist가 없으면 서명은 아무것도 증명하지 않는다
 *
 * 키서버에서 받은 키로 검증하면 "서명이 있다"만 확인된다. 공격자의 키로 서명된 파일도 그 키를
 * 받아오면 GOODSIG가 뜬다. 그래서 서명자의 fingerprint가 `node-signing-keys.json`에 있어야
 * 하고, **그 목록을 늘리는 것은 코드 리뷰가 필요한 별도 변경**이다.
 *
 * # 키는 격리된 keyring에 넣는다
 *
 * 사용자의 실제 keyring을 건드리지 않는다. 임시 `GNUPGHOME`에 받아서 쓰고 버린다 —
 * 이 명령이 개발자의 신뢰 그래프에 무언가를 남길 이유가 없다.
 *
 * 근거: docs/design/process-architecture.md 10.6절.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PIN_FILE,
  normalizeFingerprint,
  readPin,
  readSigningKeys,
} from "@tomverse/toolchain/node-runtime";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`[pin-node-runtime] ${message}`);
  process.exit(1);
}
function log(message) {
  console.log(`[pin-node-runtime] ${message}`);
}

/** 우리가 핀하는 artifact. `nodeRuntime.mjs`의 `artifactKeyFor`와 같은 집합이어야 한다. */
const ARTIFACTS = {
  "win-x64": "win-x64/node.exe",
  "win-arm64": "win-arm64/node.exe",
};

function parseArgs(argv) {
  const args = { version: null, write: false, keyserver: "https://keys.openpgp.org/vks/v1/by-fingerprint" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version") args.version = argv[++i];
    else if (arg === "--write") args.write = true;
    else if (arg === "--keyserver") args.keyserver = argv[++i];
    else fail(`알 수 없는 인자: ${arg}`);
  }
  if (!args.version) fail("--version <vX.Y.Z>가 필요합니다");
  if (!/^v\d+\.\d+\.\d+$/.test(args.version)) fail(`--version이 vX.Y.Z 형식이 아닙니다: ${args.version}`);
  return args;
}

function gpg(gnupgHome, gpgArgs, input) {
  return spawnSync("gpg", ["--batch", "--no-tty", "--homedir", gnupgHome, ...gpgArgs], {
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.text();
}

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * 서명을 검증하고 **서명자의 fingerprint**를 돌려준다.
 *
 * `VALIDSIG`의 fingerprint를 쓴다 — `GOODSIG`는 긴 key id만 준다. 40자리 전체를 비교해야
 * 하는 이유는 짧은 id가 충돌 가능하다는 것이 실증된 사실이기 때문이다.
 */
function verifySignature(gnupgHome, shasumsFile, signatureFile) {
  const result = gpg(gnupgHome, ["--status-fd", "1", "--verify", signatureFile, shasumsFile]);
  const stdout = result.stdout ?? "";
  const validsig = /^\[GNUPG:\] VALIDSIG ([0-9A-F]{40})/m.exec(stdout);
  const goodsig = /^\[GNUPG:\] GOODSIG /m.test(stdout);
  if (!validsig || !goodsig) {
    return { ok: false, detail: `${stdout}\n${result.stderr ?? ""}`.trim() };
  }
  return { ok: true, fingerprint: validsig[1] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (spawnSync("gpg", ["--version"], { encoding: "utf8" }).status !== 0) {
    fail(
      "gpg를 찾지 못했습니다. **이 명령은 gpg 없이 돌지 않는다** — 서명 검증을 건너뛰면 " +
        "핀이 '공식 배포처에서 받았다'는 주장 이상을 담지 못한다.\n" +
        "Windows라면 Git for Windows에 gpg가 들어 있다: C:\\Program Files\\Git\\usr\\bin\\gpg.exe"
    );
  }

  const allowlist = readSigningKeys();
  const base = `https://nodejs.org/dist/${args.version}`;
  const gnupgHome = fs.mkdtempSync(path.join(os.tmpdir(), "tomverse-nodekeys-"));
  fs.chmodSync(gnupgHome, 0o700);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tomverse-nodepin-"));

  try {
    log(`받는 중: ${base}/SHASUMS256.txt(.sig)`);
    const shasumsText = await fetchText(`${base}/SHASUMS256.txt`);
    const signature = await fetchBytes(`${base}/SHASUMS256.txt.sig`);
    const shasumsFile = path.join(workDir, "SHASUMS256.txt");
    const signatureFile = path.join(workDir, "SHASUMS256.txt.sig");
    fs.writeFileSync(shasumsFile, shasumsText);
    fs.writeFileSync(signatureFile, signature);

    // **allowlist의 키만 넣는다.** 서명 파일이 말하는 키를 받아오면 검증이 자기 자신을
    // 증명하는 순환이 된다.
    let imported = 0;
    for (const key of allowlist.keys) {
      const armored = await fetchText(`${args.keyserver}/${key.fingerprint}`).catch(() => null);
      if (armored === null) continue;
      if (gpg(gnupgHome, ["--import"], armored).status === 0) imported += 1;
    }
    if (imported === 0) fail("allowlist의 키를 하나도 가져오지 못했습니다 (키서버 접속을 확인하세요)");
    log(`allowlist ${allowlist.keys.length}개 중 ${imported}개를 가져왔습니다`);

    const verdict = verifySignature(gnupgHome, shasumsFile, signatureFile);
    if (!verdict.ok) fail(`SHASUMS256.txt의 서명을 검증하지 못했습니다:\n${verdict.detail}`);

    const signer = allowlist.keys.find((k) => k.fingerprint === normalizeFingerprint(verdict.fingerprint));
    if (!signer) {
      fail(
        `서명은 유효하지만 서명자가 allowlist에 없습니다: ${verdict.fingerprint}\n` +
          "nodejs/node README의 'Release keys'를 직접 확인하고, 맞다면 " +
          "packages/toolchain/node-signing-keys.json에 별도 변경으로 추가하세요."
      );
    }
    log(`서명 검증됨 — ${signer.name} (${signer.fingerprint})`);

    // 서명된 목록에서 우리가 핀하는 artifact의 해시를 꺼낸다.
    const sums = new Map();
    for (const line of shasumsText.split(/\r?\n/)) {
      const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
      if (match) sums.set(match[2], match[1]);
    }
    const artifacts = {};
    for (const [key, entry] of Object.entries(ARTIFACTS)) {
      const sha256 = sums.get(entry);
      if (!sha256) fail(`서명된 목록에 ${entry}가 없습니다 (${args.version})`);
      artifacts[key] = { url: `${base}/${entry}`, sha256 };
    }

    const pin = readPin();
    const next = {
      ...pin,
      version: args.version,
      artifacts,
      licenseUrl: `https://raw.githubusercontent.com/nodejs/node/${args.version}/LICENSE`,
      provenance: {
        shasumsUrl: `${base}/SHASUMS256.txt`,
        signatureUrl: `${base}/SHASUMS256.txt.sig`,
        signingKeyFingerprint: signer.fingerprint,
        signer: `${signer.name}`,
        verifiedAt: new Date().toISOString().slice(0, 10),
        gpgResult: "GOODSIG + VALIDSIG",
      },
    };

    console.log(JSON.stringify({ version: next.version, artifacts, provenance: next.provenance }, null, 2));

    if (!args.write) {
      log("--write를 주지 않아 파일을 고치지 않았습니다.");
      return;
    }
    fs.writeFileSync(PIN_FILE, `${JSON.stringify(next, null, 2)}\n`);
    log(`핀을 고쳤습니다: ${path.relative(REPO_ROOT, PIN_FILE)}`);
    log("커밋 메시지에 **왜 올렸는지**와 서명자를 적을 것.");
  } finally {
    fs.rmSync(gnupgHome, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error.stack ?? String(error)));
