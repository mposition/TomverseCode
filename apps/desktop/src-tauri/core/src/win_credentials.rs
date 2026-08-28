//! Windows Credential Manager — 저장이 **DPAPI를 지난다.**
//!
//! 계약과 나머지 설계는 `credentials.rs`에 있다. 여기서는 이 파일을 고칠 사람이 알아야 하는
//! 것만 적는다.
//!
//! # 왜 Credential Manager인가 — 직접 DPAPI를 부르지 않는 이유
//!
//! `CryptProtectData`를 직접 불러 결과를 파일에 두는 길도 있다. 그러면 **암호문이지만 파일이
//! 하나 생기고**, 그 파일의 수명·권한·백업·동기화 폴더 포함 여부를 우리가 관리하게 된다.
//! Credential Manager는 같은 DPAPI 위에 서 있으면서 그 관리를 OS가 한다 —
//! 사용자가 `control keymgr.dll`로 목록을 보고 지울 수 있다는 것도 이 선택의 이유다.
//! 우리가 만든 파일은 우리 앱을 지워도 남지만, Credential Manager 항목은 사용자가 볼 수 있다.
//!
//! 착지 기준 `noPlaintextAtRest`가 "앱 디렉터리와 설정 어디에도"라고 말하는 것과 맞물린다:
//! **이 경로에는 우리가 만드는 파일이 아예 없다.**
//!
//! # 저장 형식 — 되돌리기 비싼 결정
//!
//! | 무엇 | 값 | 왜 |
//! |---|---|---|
//! | `Type` | `CRED_TYPE_GENERIC` | 도메인 자격증명이 아니다. 임의 blob을 담을 수 있는 유일한 종류 |
//! | `TargetName` | `TomverseCode/<providerId>` | 접두사가 우리 항목을 한 눈에 모은다. 바꾸면 이미 저장한 키가 사라진 것처럼 보인다 |
//! | `UserName` | `<providerId>` | Credential Manager 화면에 무엇인지 보인다. **비밀이 아니다** |
//! | `CredentialBlob` | 키의 UTF-8 바이트 | UTF-16으로 두면 다른 도구가 읽을 때 인코딩을 추측해야 한다 |
//! | `Persist` | `CRED_PERSIST_LOCAL_MACHINE` | `ENTERPRISE`는 도메인 프로필과 함께 **로밍한다** — API 키를 사용자 모르게 다른 머신으로 보내지 않는다 |
//!
//! # 값을 지우지 않는 이유(zeroization)
//!
//! `CredReadW`가 준 버퍼를 `CredFree` 전에 0으로 덮는 길이 있다. 하지 않는다:
//! 주입하려면 값이 어차피 Rust `String`으로 살아야 하고, 그 `String`은 힙에 남으며
//! 페이지 파일로 나갈 수도 있다. 한쪽만 지우면 **"지웠다"는 사실이 지키지 못하는 보장을
//! 약속하게 되고**, 그러려고 취소·주입 경로에 `unsafe`를 더 넣는 것은 값어치가 없다.
//! 이 저장소가 약속하는 것은 **at rest**이지 in-memory가 아니다.
//!
//! # 검증 경계
//!
//! 이 파일은 Linux에서 **한 줄도 컴파일되지 않는다**(`windows-sys`가
//! `[target.'cfg(windows)'.dependencies]`에 있다). `win_job.rs`와 같은 성질이므로
//! (state-machine 20.5절) 여기서 통과한 `verify`가 이 파일에 대해 말해주는 것은 없다 —
//! 착지 기준 `storedThroughDpapi`/`noPlaintextAtRest`를 Windows에서 통과시켜야 확인된다.
//! 타입 검증만 별도 크레이트에서 `--target x86_64-pc-windows-msvc`로 했다.

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND, FILETIME};
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

use crate::credentials::{target_name, CredentialError, CredentialStore, Secret, StoreKind};

/// 널 종료 UTF-16. Win32 `*W` 함수가 요구하는 모양이다.
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn last_error(op: &'static str) -> CredentialError {
    // SAFETY: 인자가 없고 스레드 로컬 값을 읽을 뿐이다.
    let code = unsafe { GetLastError() };
    CredentialError::Backend {
        op,
        detail: format!("Win32 오류 {code}"),
    }
}

pub struct WindowsCredentialStore;

impl Default for WindowsCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowsCredentialStore {
    pub fn new() -> Self {
        Self
    }
}

impl CredentialStore for WindowsCredentialStore {
    fn kind(&self) -> StoreKind {
        StoreKind::WindowsCredentialManager
    }

    fn store(&self, provider_id: &str, secret: Secret) -> Result<(), CredentialError> {
        let mut target = wide(&target_name(provider_id)?);
        let mut user = wide(provider_id);
        // **여기서만 값을 꺼낸다.** blob은 이 함수 스코프에 살아 있어야 한다.
        let mut blob: Vec<u8> = secret.expose().as_bytes().to_vec();

        let credential = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            LastWritten: FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            // `usize -> u32`는 blob이 4GiB를 넘을 때만 문제인데 API 키에서는 일어나지 않는다.
            // 그래도 잘라내면 **다른 값이 저장되므로**, 넘치면 저장하지 않는다.
            CredentialBlobSize: u32::try_from(blob.len()).map_err(|_| CredentialError::Backend {
                op: "write",
                detail: "값이 너무 깁니다".to_string(),
            })?,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: user.as_mut_ptr(),
        };

        // SAFETY: 구조체가 가리키는 세 버퍼(`target`/`user`/`blob`)가 모두 이 스코프에 살아
        // 있고, 호출은 동기적이다. API는 값을 복사해 가므로 반환 후 버퍼가 사라져도 된다.
        let ok = unsafe { CredWriteW(&credential, 0) };
        if ok == 0 {
            return Err(last_error("write"));
        }
        Ok(())
    }

    fn forget(&self, provider_id: &str) -> Result<bool, CredentialError> {
        let target = wide(&target_name(provider_id)?);
        // SAFETY: 널 종료된 UTF-16 버퍼를 넘기고 그 버퍼는 호출 동안 살아 있다.
        let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok != 0 {
            return Ok(true);
        }
        // **"없었다"와 "실패했다"를 가른다.** 없는 것을 지우는 것은 오류가 아니다 —
        // 뭉개면 화면이 "지우지 못했습니다"를 이유 없이 띄운다.
        // SAFETY: 위 `last_error`와 같다.
        if unsafe { GetLastError() } == ERROR_NOT_FOUND {
            return Ok(false);
        }
        Err(last_error("delete"))
    }

    fn has(&self, provider_id: &str) -> Result<bool, CredentialError> {
        // **값을 읽어서 버린다.** Credential Manager에는 "존재만 묻는" API가 없다 —
        // `CredReadW`가 유일한 길이다. 값이 이 함수를 지나지만 밖으로 나가지 않는다는 것이
        // 요점이고, 그래서 반환 타입이 `bool`이다.
        Ok(self.read_for_injection(provider_id)?.is_some())
    }

    fn read_for_injection(&self, provider_id: &str) -> Result<Option<Secret>, CredentialError> {
        let target = wide(&target_name(provider_id)?);
        let mut raw: *mut CREDENTIALW = std::ptr::null_mut();

        // SAFETY: `target`은 널 종료 UTF-16이고 호출 동안 살아 있다. `raw`는 성공 시에만
        // 유효한 포인터로 채워지며, 아래에서 반드시 `CredFree`로 돌려준다.
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) };
        if ok == 0 {
            // SAFETY: 위와 같다.
            if unsafe { GetLastError() } == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(last_error("read"));
        }
        if raw.is_null() {
            // 성공을 보고했는데 포인터가 없다. 추측해서 계속하지 않는다.
            return Err(CredentialError::Backend {
                op: "read",
                detail: "성공을 보고했으나 자격증명 포인터가 비어 있습니다".to_string(),
            });
        }

        // **`CredFree` 전에 복사를 끝낸다.** 아래 블록 밖으로 포인터를 들고 나가지 않는 것이
        // 이 함수에서 지켜야 할 전부다 — 여기서 틀리는 흔한 방식이 수명이다.
        //
        // SAFETY: `raw`는 API가 채운 유효한 포인터이고, `CredentialBlob`/`CredentialBlobSize`는
        // 같은 구조체가 기술하는 한 덩어리다. 크기가 0이면 슬라이스를 만들지 않는다
        // (`from_raw_parts`는 길이가 0이어도 널 포인터를 허용하지 않는다).
        let bytes: Vec<u8> = unsafe {
            let cred = &*raw;
            if cred.CredentialBlobSize == 0 || cred.CredentialBlob.is_null() {
                Vec::new()
            } else {
                std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize).to_vec()
            }
        };
        // SAFETY: `CredReadW`가 할당한 버퍼를 정확히 한 번 돌려준다. 이 아래에서 `raw`를
        // 다시 쓰지 않는다.
        unsafe { CredFree(raw as *const c_void) };

        // 저장한 것은 UTF-8이다. 아니라면 우리가 쓴 항목이 아니거나 손상된 것이므로,
        // 손실 변환으로 그럴듯한 키를 만들어 인증 실패로 보내지 않는다.
        let value = String::from_utf8(bytes).map_err(|_| CredentialError::Backend {
            op: "read",
            detail: "저장된 값이 UTF-8이 아닙니다 — 이 앱이 쓴 항목이 아닐 수 있습니다".to_string(),
        })?;

        // 빈 값은 **없는 것으로 본다.** `Secret::new`의 규칙과 같아야 한다 —
        // 갈라지면 "저장할 때는 거부되는데 읽을 때는 통과하는" 값이 생긴다.
        match Secret::new(value) {
            Ok(secret) => Ok(Some(secret)),
            Err(_) => Ok(None),
        }
    }
}
