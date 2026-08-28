/**
 * `nodeRuntime.mjs`의 타입 선언 — 손으로 쓴다.
 *
 * 구현이 일반 JavaScript인 이유는 `nodeRuntime.mjs` 상단에 있다(빌드 순환 회피). 그 대가로
 * 타입을 여기서 따로 유지해야 하고, 둘이 갈라지면 타입 검사가 조용히 틀린 답을 낸다.
 * `test/sidecarBundle.test.ts`가 선언된 이름을 실제로 불러 그 갈라짐을 잡는다.
 */

export declare const BUNDLE_DIR: string;
export declare const ENTRY_FILE: string;
export declare const MANIFEST_FILE: string;
export declare const RUNTIME_LICENSE_FILE: string;
export declare const MANIFEST_SCHEMA_VERSION: number;
export declare const DEFAULT_STAGE_ROOT_REL: string;
export declare const PIN_FILE: string;
export declare const SIGNING_KEYS_FILE: string;

export declare function runtimeFileName(windows: boolean): string;

export interface PinArtifact {
  url: string;
  sha256: string;
}

export interface Pin {
  schemaVersion: number;
  version: string;
  artifacts: Record<string, PinArtifact>;
  licenseUrl: string;
  provenance: {
    shasumsUrl: string;
    signatureUrl: string;
    signingKeyFingerprint: string;
    signer: string;
    verifiedAt: string;
    gpgResult: string;
  };
}

export interface SigningKey {
  fingerprint: string;
  name: string;
}

export interface SigningKeys {
  schemaVersion: number;
  source: string;
  checkedAt: string;
  keys: SigningKey[];
}

export type ArtifactKeyResult = { ok: true; key: string } | { ok: false; reason: string };

export declare function artifactKeyFor(platform: string, arch: string): ArtifactKeyResult;
export declare function readPin(file?: string): Pin;
export declare function readSigningKeys(file?: string): SigningKeys;
export declare function normalizeFingerprint(value: string): string;
export declare function artifactFor(pin: Pin, platform: string, arch: string): PinArtifact & { key: string };
export declare function requiredBundleFiles(windows: boolean): string[];
