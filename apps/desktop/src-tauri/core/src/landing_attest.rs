//! 착지 판정에 **사람의 확인을 넣는 입구**.
//!
//! # 왜 필요한가
//!
//! `landing.rs`는 "확인했다는 기억"과 "확인됐다는 기록"을 가르려고 만들어졌다. 그런데 그
//! 도구에는 사람이 확인한 결과를 넣을 자리가 없었다 — 항목이 `NeedsHuman`으로 하드코딩되어
//! 있어, 실제로 Windows에서 확인해도 다음 실행은 **똑같이** 같은 수를 `remaining`으로 냈다.
//! 그러면 확인한 사실이 다시 사람의 기억(또는 문서의 산문)에만 남는다. 이 도구가 없애려던
//! 바로 그 상태다(windows-landing-record.md 15절).
//!
//! # 무엇을 지키는가 — 이 모듈이 없으면 도구가 착시를 만드는 쪽이 된다
//!
//! 1. **`Failed`를 덮지 못한다.** 사람의 확인은 `NeedsHuman`/`NotCheckableHere`를 `Passed`로
//!    바꾸는 것이지, 도구가 **실제로 관측한 실패**를 지우는 것이 아니다. `NotImplemented`도
//!    덮지 못한다 — 없는 기능을 확인할 수는 없다.
//! 2. **머신 사양이 판정에 반영된다.** "Python으로 확인했다"는 **Python이 있는 머신에서만**
//!    뜻이 있다. 실측 머신에는 Python이 없어서 `pythonEnv` 두 항목을 확인할 수 없었는데
//!    (기록 1·10절), 그 사실이 기록에 남고 판정이 그것을 읽는다. 그래서 `MachineSpec`의
//!    필드는 **하나도 생략할 수 없다** — 빠뜨리는 것이 회피 수단이 되면 안 되므로, 없으면
//!    `null`이라고 **적어야** 한다.
//! 3. **커밋이 바뀌면 만료된다.** 안 그러면 옛 확인이 새 코드를 통과시킨다.
//! 4. **해시는 재귀 canonical JSON이다.** 가설 게이트가 `JSON.stringify(v, Object.keys(v).sort())`로
//!    중첩 객체를 통째로 지워 "해시가 있는데 아무것도 지키지 못하던" 결함을 겪었다
//!    (evals/hypothesis-gate/src/canonical.ts). 같은 실수를 반복하지 않는다.
//!
//! # 여기에 **없는** 것 — 자동으로 채워주는 명령
//!
//! attestation을 만들어 주는 하위 명령은 만들지 않는다. 사람이 확인한 것을 사람이 적는 것이
//! 이 기록의 전부이고, 도구가 스스로 채우면 그 순간 아무것도 증명하지 않는다.
//!
//! 해시만은 예외처럼 보이지만 아니다. 해시가 맞지 않으면 이 모듈은 **재계산한 값을 알려주고
//! 거부한다** — 그 값을 파일에 옮겨 적는 것은 사람이다. 알려주는 것은 "무엇을 확인했는가"가
//! 아니라 "이 내용이 그 뒤로 바뀌지 않았다"는 봉인뿐이다.
//!
//! # 위협 모델 — 이건 전자서명이 아니다
//!
//! 해시는 **무결성 검사**다. 파일이 편집기에서 실수로 저장됐거나 다른 실행의 것으로 바뀐 것을
//! 잡지만, 내용을 바꾼 뒤 해시를 다시 계산해 넣는 사람을 막지 못한다. 막으려는 것은 공격자가
//! 아니라 사고다. 위조를 막고 싶다면 서명 키가 필요하고, 그건 여기 없다.

use serde_json::Value;
use sha2::{Digest, Sha256};

/// 이 코드가 읽는 형식. 올릴 때 옛 형식을 조용히 읽지 않는다 —
/// 착지 기준의 의미가 바뀌면 옛 확인은 그 기준에 대한 확인이 아니다.
pub const SCHEMA_VERSION: u32 = 1;
pub const KIND: &str = "windows-landing-attestation";
/// 자기 자신은 해시에서 빠진다. **다른 필드는 하나도 빼지 않는다** — 손으로 나열한 제외
/// 목록은 새 필드를 넣을 때 잊는 순간 그 필드가 조용히 해시 밖으로 빠진다.
pub const HASH_FIELD: &str = "attestationHash";
/// 커밋을 이보다 짧게 적으면 다른 커밋과 겹칠 수 있다.
pub const MIN_COMMIT_LEN: usize = 7;

// ---- canonical JSON ----

/// 재귀적으로 정규화된 JSON.
///
/// key를 **모든 깊이에서** 정렬하고, 배열의 **순서는 보존한다**(순서가 의미인 값이 있다).
/// 가설 게이트의 `canonical.ts`와 같은 규칙이다.
pub fn canonical_json(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    encode(value, "$", &mut out)?;
    Ok(out)
}

fn encode(value: &Value, pointer: &str, out: &mut String) -> Result<(), String> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            // serde_json은 기본 설정에서 NaN/Infinity를 `Number`로 담지 못하지만, 그 사실에
            // 기대지 않는다 — 기능 플래그 하나로 바뀔 수 있는 전제 위에 해시를 세우지 않는다.
            if let Some(f) = n.as_f64() {
                if !f.is_finite() {
                    return Err(format!("{pointer}: 유한한 수가 아닙니다"));
                }
            }
            out.push_str(&n.to_string());
        }
        Value::String(s) => out.push_str(&Value::String(s.clone()).to_string()),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                encode(item, &format!("{pointer}[{i}]"), out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // **정렬을 serde_json의 내부 자료구조에 맡기지 않는다.** 기본 `Map`은 정렬된
            // BTreeMap이지만 `preserve_order` 기능이 켜지는 순간 삽입 순서가 되고, 그러면
            // 같은 내용이 다른 해시를 낸다. 여기서 명시적으로 정렬한다.
            let mut keys: Vec<&String> = map.keys().collect();
            // UTF-16이 아니라 바이트 순서다. 두 정렬이 갈리는 것은 보조 평면(surrogate) 문자
            // 뿐이고, 이 아티팩트의 key는 우리가 정하는 ASCII 식별자다. 규칙을 여기 적어둔다.
            keys.sort();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*key).clone()).to_string());
                out.push(':');
                encode(&map[*key], &format!("{pointer}.{key}"), out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// 해시 필드 **자신만** 빼고 해시한다.
pub fn hash_excluding_field(value: &Value, field: &str) -> Result<String, String> {
    let Value::Object(map) = value else {
        return Err("객체가 아닙니다".to_string());
    };
    let mut rest = map.clone();
    rest.remove(field);
    let canonical = canonical_json(&Value::Object(rest))?;
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(format!("{digest:x}"))
}

// ---- 기록의 모양 ----

/// 이 기준을 **사람이 확인하려면** 그 머신에 무엇이 있어야 하는가.
///
/// 기준 옆(`landing.rs`)에 적는다. 여기에 목록으로 몰아두면 기준을 고칠 때 요구를 함께
/// 고치지 않게 되고, 그러면 없는 것으로 확인했다는 기록이 통과한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MachineFact {
    WindowsOs,
    /// Node와 npm shim — `commandResolution`이 해석하는 대상 자체다.
    NodeAndNpm,
    /// C++ 도구가 **있는** Visual Studio. 설치가 있다는 것과 다르다(기록 1·9절).
    VisualStudioWithCxx,
    /// Git for Windows — GNU `link.exe`가 PATH를 가리는 상황을 만들 수 있어야 한다.
    GitForWindows,
    /// 실행 가능한 Python. Store 별칭은 Python이 **아니다**(기록 10절).
    Python,
    /// 설치된 앱(설치본). "번들 파일이 있다"와 "그것으로 뜬다"는 다른 사실이다.
    InstalledBundle,
}

impl MachineFact {
    pub fn label(self) -> &'static str {
        match self {
            MachineFact::WindowsOs => "Windows",
            MachineFact::NodeAndNpm => "Node + npm shim",
            MachineFact::VisualStudioWithCxx => "C++ 도구가 있는 Visual Studio",
            MachineFact::GitForWindows => "Git for Windows",
            MachineFact::Python => "실행 가능한 Python",
            MachineFact::InstalledBundle => "설치된 앱",
        }
    }
}

/// 확인이 이루어진 머신. **필드를 생략할 수 없다** — 없으면 `null`이라고 적는다.
///
/// 생략을 허용하면 "적지 않는 것"이 요구를 피하는 가장 쉬운 길이 되고, 그러면 기록이
/// 판정 재료가 아니라 장식이 된다. 기록 1절이 왜 표로 시작하는지가 그 이유다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MachineSpec {
    pub os: String,
    /// 빌드 번호까지. `10.0.19045`처럼 — Windows는 버전보다 빌드가 동작을 가른다.
    pub os_version: String,
    pub node_version: Option<String>,
    /// 실제로 해석된 npm shim의 경로. nvm4w/volta/fnm은 **구조가 다르다**.
    pub npm_shim: Option<String>,
    /// `vcvarsall.bat`을 실제로 가진 설치의 경로.
    pub visual_studio: Option<String>,
    pub git_for_windows: Option<String>,
    /// `core.autocrlf`. CRLF 작업 트리인지가 patch 경로의 전제였다(기록 3절).
    pub git_autocrlf: Option<String>,
    /// 실행 가능한 Python의 경로. Store 별칭이면 `null`이다 — 그건 Python이 아니다.
    pub python: Option<String>,
    /// 설치본을 실제로 설치해 실행한 경로.
    pub installed_bundle: Option<String>,
}

impl MachineSpec {
    fn satisfies(&self, fact: MachineFact) -> bool {
        match fact {
            MachineFact::WindowsOs => self.os == "windows",
            MachineFact::NodeAndNpm => self.node_version.is_some() && self.npm_shim.is_some(),
            MachineFact::VisualStudioWithCxx => self.visual_studio.is_some(),
            MachineFact::GitForWindows => self.git_for_windows.is_some(),
            MachineFact::Python => self.python.is_some(),
            MachineFact::InstalledBundle => self.installed_bundle.is_some(),
        }
    }

    /// 요구 중 **충족되지 않은 것**. 통과가 아니라 무엇이 모자란지를 돌려준다 —
    /// 사람이 파일을 고칠 수 있어야 한다.
    pub fn missing(&self, required: &[MachineFact]) -> Vec<MachineFact> {
        required.iter().copied().filter(|f| !self.satisfies(*f)).collect()
    }

    /// 보고서에 싣는 한 줄 요약.
    pub fn summary(&self) -> String {
        format!(
            "{} {} / node {} / VS {} / python {}",
            self.os,
            self.os_version,
            self.node_version.as_deref().unwrap_or("없음"),
            self.visual_studio.as_deref().unwrap_or("없음"),
            self.python.as_deref().unwrap_or("없음"),
        )
    }
}

/// 확인한 기준 하나.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AttestedCheck {
    pub group: String,
    pub check: String,
    pub observed_at: String,
    /// **무엇을 보고 그렇게 판단했는가.** 비어 있으면 거부한다 — 이 기록의 전부가 이것이고,
    /// 근거 없는 통과 표시는 착시를 만드는 쪽이다.
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Attestation {
    pub schema_version: u32,
    pub kind: String,
    pub attestation_id: String,
    /// **누가** 확인했는가. 기록의 목적 절반이 이것이다.
    pub attested_by: String,
    pub created_at: String,
    /// **어느 커밋에서** 확인했는가. 이게 만료의 근거다.
    pub commit: String,
    pub machine: MachineSpec,
    pub checks: Vec<AttestedCheck>,
    pub attestation_hash: String,
}

/// 파일을 읽어 들인 결과. **거부도 결과다** — 조용히 없는 것으로 치지 않는다.
#[derive(Debug, Clone)]
pub struct AttestationSource {
    pub file: String,
    pub parsed: Result<Attestation, Vec<String>>,
}

/// 파일에서 읽는다. IO는 여기에만 있고 판정은 전부 순수 함수다.
pub fn read_file(path: &std::path::Path) -> AttestationSource {
    let file = path.display().to_string();
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) => {
            return AttestationSource {
                file,
                parsed: Err(vec![format!("attestation 파일을 읽을 수 없습니다: {e}")]),
            }
        }
    };
    let raw: Value = match serde_json::from_str(&text) {
        Ok(raw) => raw,
        Err(e) => {
            return AttestationSource {
                file,
                parsed: Err(vec![format!("attestation이 JSON이 아닙니다: {e}")]),
            }
        }
    };
    AttestationSource {
        file,
        parsed: parse(&raw),
    }
}

/// 원문 JSON을 검사해 attestation으로 읽는다. **아무것도 고쳐주지 않는다.**
///
/// 해시는 **역직렬화한 구조체가 아니라 원문**에서 계산한다. 구조체로 왕복시키면 우리가 모르는
/// 필드가 조용히 빠지고, 그러면 "해시는 같은데 파일 내용이 다른" 두 문서가 생긴다.
/// (`deny_unknown_fields`가 그런 필드를 애초에 거부하지만, 해시의 근거를 그 검사에
/// 의존시키지 않는다 — 둘은 서로를 대신하지 못한다.)
pub fn parse(raw: &Value) -> Result<Attestation, Vec<String>> {
    let mut reasons: Vec<String> = Vec::new();

    if !raw.is_object() {
        return Err(vec!["attestation이 객체가 아닙니다".to_string()]);
    }

    let attestation: Attestation = match serde_json::from_value(raw.clone()) {
        Ok(a) => a,
        Err(e) => return Err(vec![format!("attestation의 모양이 다릅니다: {e}")]),
    };

    if attestation.schema_version != SCHEMA_VERSION {
        reasons.push(format!(
            "attestation 스키마 버전이 {}입니다 (이 코드는 {SCHEMA_VERSION}만 읽습니다) — \
             기준의 의미가 바뀌었을 수 있으므로 다시 확인하고 새로 적으세요",
            attestation.schema_version
        ));
    }
    if attestation.kind != KIND {
        reasons.push(format!(
            "attestation의 kind가 {}입니다 ({KIND}이어야 합니다)",
            attestation.kind
        ));
    }

    // 해시 — 형식부터 본다. 잘라 쓴 해시가 우연히 통과하지 않게 한다.
    let stored = attestation.attestation_hash.trim();
    if stored.len() != 64 || !stored.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        reasons.push(format!(
            "{HASH_FIELD}가 64자리 소문자 hex가 아닙니다 ({stored})"
        ));
    } else {
        match hash_excluding_field(raw, HASH_FIELD) {
            Ok(recomputed) if recomputed == stored => {}
            Ok(recomputed) => reasons.push(format!(
                "{HASH_FIELD}가 다릅니다 (저장 {stored} / 재계산 {recomputed}) — 파일이 그 뒤로 \
                 바뀌었습니다. 내용이 맞다면 재계산한 값을 적으세요. 이 값은 **무엇을 확인했는지**를 \
                 채워주지 않습니다 — 내용이 바뀌지 않았음을 봉인할 뿐입니다."
            )),
            Err(e) => reasons.push(format!("{HASH_FIELD}를 계산할 수 없습니다: {e}")),
        }
    }

    if attestation.attested_by.trim().is_empty() {
        reasons.push("attestedBy가 비어 있습니다 — 누가 확인했는지가 이 기록의 절반입니다".to_string());
    }
    if attestation.attestation_id.trim().is_empty() {
        reasons.push("attestationId가 비어 있습니다".to_string());
    }
    if attestation.created_at.trim().is_empty() {
        reasons.push("createdAt이 비어 있습니다".to_string());
    }

    let commit = attestation.commit.trim();
    if commit.len() < MIN_COMMIT_LEN || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        reasons.push(format!(
            "commit이 {MIN_COMMIT_LEN}자리 이상의 hex가 아닙니다 ({commit}) — \
             더 짧으면 다른 커밋과 겹칠 수 있습니다"
        ));
    }

    if attestation.machine.os.trim().is_empty() || attestation.machine.os_version.trim().is_empty() {
        reasons.push("machine.os / machine.osVersion이 비어 있습니다".to_string());
    }

    // **머신 사양의 필드는 생략할 수 없다.**
    //
    // `deny_unknown_fields`는 더 적은 것을 막지 못하고, serde의 `Option<T>`는 없는 필드를
    // 조용히 `None`으로 만든다. 그러면 "python을 적지 않는 것"이 "python이 없다"와 같아지는데,
    // 그 둘은 다르다 — 앞은 확인하지 않은 것이고 뒤는 확인한 사실이다. 없으면 `null`이라고
    // **적어야** 한다.
    //
    // 기대 key는 손으로 나열하지 않고 `MachineSpec` 자신을 직렬화해 얻는다. 목록을 적어두면
    // 필드를 추가할 때 넣는 것을 잊고, 그 필드는 조용히 생략 가능해진다.
    if let (Some(given), Ok(Value::Object(expected))) = (
        raw.get("machine").and_then(Value::as_object),
        serde_json::to_value(&attestation.machine),
    ) {
        let mut missing: Vec<&str> = expected
            .keys()
            .filter(|k| !given.contains_key(*k))
            .map(|k| k.as_str())
            .collect();
        missing.sort();
        if !missing.is_empty() {
            reasons.push(format!(
                "machine에 빠진 필드가 있습니다: {} — 없으면 `null`이라고 적으세요. \
                 적지 않는 것이 요구를 피하는 길이 되면 이 기록은 판정 재료가 아니라 장식입니다.",
                missing.join(", ")
            ));
        }
    }

    if attestation.checks.is_empty() {
        reasons.push("확인한 기준이 하나도 없습니다".to_string());
    }
    for (i, c) in attestation.checks.iter().enumerate() {
        if c.group.trim().is_empty() || c.check.trim().is_empty() {
            reasons.push(format!("checks[{i}]의 group/check가 비어 있습니다"));
        }
        if c.evidence.trim().is_empty() {
            reasons.push(format!(
                "checks[{i}]({}/{})의 evidence가 비어 있습니다 — 무엇을 보고 그렇게 판단했는지가 \
                 이 기록의 전부입니다",
                c.group, c.check
            ));
        }
        if c.observed_at.trim().is_empty() {
            reasons.push(format!("checks[{i}]({}/{})의 observedAt이 비어 있습니다", c.group, c.check));
        }
    }

    if reasons.is_empty() {
        Ok(attestation)
    } else {
        Err(reasons)
    }
}

/// 커밋이 같은가 — **만료 판정**.
///
/// 짧게 적은 커밋을 허용하므로 접두사로 비교한다. 어느 쪽이 짧든 상관없다(사람은 짧게 적고
/// git은 40자리를 준다). 대소문자는 무시한다.
pub fn commit_matches(attested: &str, head: &str) -> bool {
    let a = attested.trim().to_ascii_lowercase();
    let h = head.trim().to_ascii_lowercase();
    if a.len() < MIN_COMMIT_LEN || h.len() < MIN_COMMIT_LEN {
        return false;
    }
    if a.len() <= h.len() {
        h.starts_with(&a)
    } else {
        a.starts_with(&h)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// **중첩 필드를 바꾸면 해시가 바뀐다.**
    ///
    /// 가설 게이트가 겪은 결함이 정확히 여기였다: `JSON.stringify(v, Object.keys(v).sort())`는
    /// 최상위 key만 whitelist로 남기고 **모든 깊이에** 그것을 적용해 중첩 객체를 `{}`로
    /// 만들었다. 그래서 해시가 있는데 아무것도 지키지 못했다.
    #[test]
    fn the_hash_covers_nested_fields() {
        let base = json!({ "a": 1, "nested": { "x": 1 }, "arr": [{ "h": "aaa" }] });
        let nested_changed = json!({ "a": 1, "nested": { "x": 9 }, "arr": [{ "h": "aaa" }] });
        let deep_in_array = json!({ "a": 1, "nested": { "x": 1 }, "arr": [{ "h": "bbb" }] });

        let h = |v: &Value| hash_excluding_field(v, HASH_FIELD).expect("해시");
        assert_ne!(h(&base), h(&nested_changed), "중첩 객체의 변화가 해시에 반영되지 않았습니다");
        assert_ne!(h(&base), h(&deep_in_array), "배열 안 객체의 변화가 해시에 반영되지 않았습니다");
    }

    /// key 순서만 다른 두 문서는 **같은** 해시다. 아니면 들여쓰기를 고친 것만으로 만료된다.
    #[test]
    fn key_order_does_not_change_the_hash() {
        let a = json!({ "b": { "z": 1, "a": 2 }, "a": 1 });
        let b = json!({ "a": 1, "b": { "a": 2, "z": 1 } });
        assert_eq!(canonical_json(&a).unwrap(), canonical_json(&b).unwrap());
    }

    /// 배열의 **순서는 의미다** — argv도 확인 순서도 그렇다.
    #[test]
    fn array_order_is_preserved() {
        let a = json!({ "v": [1, 2] });
        let b = json!({ "v": [2, 1] });
        assert_ne!(canonical_json(&a).unwrap(), canonical_json(&b).unwrap());
    }

    fn machine() -> Value {
        json!({
            "os": "windows",
            "osVersion": "10.0.19045",
            "nodeVersion": "v22.22.2",
            "npmShim": "C:\\nvm4w\\nodejs\\npm.CMD",
            "visualStudio": "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools",
            "gitForWindows": "C:\\Program Files\\Git",
            "gitAutocrlf": "true",
            "python": null,
            "installedBundle": null
        })
    }

    fn sealed(mut raw: Value) -> Value {
        let hash = hash_excluding_field(&raw, HASH_FIELD).expect("해시");
        raw[HASH_FIELD] = json!(hash);
        raw
    }

    pub(crate) fn sample() -> Value {
        sealed(json!({
            "schemaVersion": SCHEMA_VERSION,
            "kind": KIND,
            "attestationId": "sample",
            "attestedBy": "Vyper",
            "createdAt": "2026-08-27T00:00:00Z",
            "commit": "206d2ef",
            "machine": machine(),
            "checks": [{
                "group": "commandResolution",
                "check": "npmResolvesToNodeCli",
                "observedAt": "2026-08-27T00:00:00Z",
                "evidence": "TOOL_COMPLETED의 resolvedCommand가 node.exe + npm-cli.js였다"
            }],
            "attestationHash": ""
        }))
    }

    #[test]
    fn a_well_formed_attestation_parses() {
        let parsed = parse(&sample()).expect("읽히지 않았습니다");
        assert_eq!(parsed.attested_by, "Vyper");
        assert_eq!(parsed.checks.len(), 1);
        assert!(parsed.machine.python.is_none());
    }

    /// 한 글자만 고쳐도 봉인이 깨진다 — 그게 해시의 전부다.
    #[test]
    fn editing_the_file_breaks_the_seal() {
        let mut raw = sample();
        raw["checks"][0]["evidence"] = json!("사실은 확인하지 않았다");
        let reasons = parse(&raw).expect_err("통과했습니다");
        assert!(reasons.iter().any(|r| r.contains(HASH_FIELD)), "{reasons:?}");
    }

    /// 우리가 모르는 필드를 넣는 것은 **거부**다. 조용히 버리면 그 필드는 해시에는 들어가고
    /// 판정에는 안 들어가는, 사람이 오해하기 딱 좋은 상태가 된다.
    #[test]
    fn unknown_fields_are_refused() {
        let mut raw = sample();
        raw["madeUpField"] = json!(true);
        let raw = sealed(raw);
        let reasons = parse(&raw).expect_err("통과했습니다");
        assert!(reasons.iter().any(|r| r.contains("모양이 다릅니다")), "{reasons:?}");
    }

    /// 머신 사양은 **생략할 수 없다.** 빠뜨리는 것이 요구를 피하는 길이 되면 안 된다.
    #[test]
    fn an_omitted_machine_field_is_refused_not_defaulted() {
        let mut raw = sample();
        raw["machine"].as_object_mut().unwrap().remove("python");
        let raw = sealed(raw);
        let reasons = parse(&raw).expect_err("통과했습니다");
        assert!(reasons.iter().any(|r| r.contains("빠진 필드")), "{reasons:?}");
    }

    #[test]
    fn evidence_may_not_be_empty() {
        let mut raw = sample();
        raw["checks"][0]["evidence"] = json!("   ");
        let raw = sealed(raw);
        let reasons = parse(&raw).expect_err("통과했습니다");
        assert!(reasons.iter().any(|r| r.contains("evidence")), "{reasons:?}");
    }

    #[test]
    fn a_short_commit_is_refused() {
        let mut raw = sample();
        raw["commit"] = json!("206d");
        let raw = sealed(raw);
        let reasons = parse(&raw).expect_err("통과했습니다");
        assert!(reasons.iter().any(|r| r.contains("commit")), "{reasons:?}");
    }

    #[test]
    fn commit_comparison_accepts_short_forms_only_when_they_prefix() {
        assert!(commit_matches("206d2ef", "206d2ef3678c13722f29cb025693f2e6ad8b8307"));
        assert!(commit_matches("206D2EF", "206d2ef3678c13722f29cb025693f2e6ad8b8307"));
        assert!(!commit_matches("206d2ef", "f9767a3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        // 너무 짧으면 겹칠 수 있으므로 접두사여도 같다고 하지 않는다.
        assert!(!commit_matches("206", "206d2ef3678c13722f29cb025693f2e6ad8b8307"));
    }

    #[test]
    fn machine_requirements_report_what_is_missing() {
        let spec: MachineSpec = serde_json::from_value(machine()).expect("machine");
        assert!(spec.missing(&[MachineFact::WindowsOs, MachineFact::NodeAndNpm]).is_empty());
        assert_eq!(spec.missing(&[MachineFact::Python]), vec![MachineFact::Python]);
        assert_eq!(
            spec.missing(&[MachineFact::InstalledBundle]),
            vec![MachineFact::InstalledBundle]
        );
    }
}
