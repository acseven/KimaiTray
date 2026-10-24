//! Administrator-managed settings (Group Policy).
//!
//! On Windows the policy lives in `HKLM\SOFTWARE\Policies\KimaiTray`, with the
//! same key under HKCU as a per-user fallback; a machine value always wins, as
//! with Windows' own policies. Values are returned raw and validated by the
//! frontend (`src/settings/policy.ts`). Other platforms report no policy.

use serde_json::{Map, Value};
use tauri::AppHandle;

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Clone, Copy)]
enum Kind {
    Text,
    Number,
}

/// Registry value name, JSON key used by the frontend, value type.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const POLICY_VALUES: &[(&str, &str, Kind)] = &[
    ("KimaiUrl", "kimaiUrl", Kind::Text),
    ("KimaiUrlLocked", "kimaiUrlLocked", Kind::Number),
    ("Language", "language", Kind::Text),
    ("LaunchAtLogin", "launchAtLogin", Kind::Number),
    ("RefreshInterval", "refreshInterval", Kind::Number),
    ("DisableUpdates", "disableUpdates", Kind::Number),
    ("EnableIdleDetection", "enableIdleDetection", Kind::Number),
    ("IdleThresholdMinutes", "idleThresholdMinutes", Kind::Number),
    ("IdleAction", "idleAction", Kind::Text),
    ("EnableNoTimerReminder", "enableNoTimerReminder", Kind::Number),
    ("NoTimerReminderMinutes", "noTimerReminderMinutes", Kind::Number),
];

/// Machine values take precedence; user values only fill the gaps.
fn merge(machine: Map<String, Value>, user: Map<String, Value>) -> Map<String, Value> {
    let mut merged = user;
    merged.extend(machine);
    merged
}

#[cfg(target_os = "windows")]
mod registry {
    use super::{Kind, POLICY_VALUES};
    use serde_json::{Map, Value};
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD,
        RRF_RT_REG_SZ,
    };

    const POLICY_KEY: &str = r"SOFTWARE\Policies\KimaiTray";
    const MAX_TEXT_BYTES: u32 = 8 * 1024;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn read_dword(root: HKEY, name: &str) -> Option<u32> {
        let key = wide(POLICY_KEY);
        let value = wide(name);
        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: all pointers reference live, correctly sized buffers.
        let status = unsafe {
            RegGetValueW(
                root,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut data as *mut u32).cast(),
                &mut size,
            )
        };
        (status == ERROR_SUCCESS).then_some(data)
    }

    fn read_text(root: HKEY, name: &str) -> Option<String> {
        let key = wide(POLICY_KEY);
        let value = wide(name);
        let mut size: u32 = 0;
        // SAFETY: a null data pointer asks only for the required size.
        let status = unsafe {
            RegGetValueW(
                root,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS || size == 0 || size > MAX_TEXT_BYTES {
            return None;
        }
        let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
        // SAFETY: `buffer` holds at least `size` bytes.
        let status = unsafe {
            RegGetValueW(
                root,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        String::from_utf16(&buffer[..end]).ok()
    }

    pub(super) fn read(root: HKEY) -> Map<String, Value> {
        let mut values = Map::new();
        for &(name, key, kind) in POLICY_VALUES {
            let value = match kind {
                Kind::Number => read_dword(root, name).map(Value::from),
                Kind::Text => read_text(root, name).map(Value::from),
            };
            if let Some(value) = value {
                values.insert(key.to_string(), value);
            }
        }
        values
    }

    pub(super) fn machine() -> Map<String, Value> {
        read(HKEY_LOCAL_MACHINE)
    }

    pub(super) fn user() -> Map<String, Value> {
        read(HKEY_CURRENT_USER)
    }
}

pub fn read_policy() -> Map<String, Value> {
    #[cfg(target_os = "windows")]
    {
        merge(registry::machine(), registry::user())
    }
    #[cfg(not(target_os = "windows"))]
    {
        merge(Map::new(), Map::new())
    }
}

#[tauri::command]
pub fn get_managed_policy() -> Map<String, Value> {
    read_policy()
}

/// Applies policies that must hold even before the UI loads.
pub fn enforce_at_startup(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;

    let Some(launch) = read_policy().get("launchAtLogin").and_then(Value::as_u64) else {
        return;
    };
    let autolaunch = app.autolaunch();
    let result = match launch {
        1 => autolaunch.enable(),
        0 => autolaunch.disable(),
        _ => return,
    };
    if let Err(error) = result {
        log::warn!("Failed to apply LaunchAtLogin policy: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::merge;
    use serde_json::{json, Map, Value};

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn machine_policy_overrides_user_policy() {
        let merged = merge(
            map(json!({ "language": "pt", "disableUpdates": 1 })),
            map(json!({ "language": "de", "refreshInterval": 300 })),
        );
        assert_eq!(merged["language"], json!("pt"));
        assert_eq!(merged["disableUpdates"], json!(1));
        assert_eq!(merged["refreshInterval"], json!(300));
    }
}
