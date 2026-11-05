//! Timestamps for folder names and run times, in UTC (there is no time-zone
//! crate here; singl-web used local time for folder names).

use std::time::{SystemTime, UNIX_EPOCH};

struct Parts {
  year: i64,
  month: u32,
  day: u32,
  hour: u32,
  minute: u32,
  second: u32,
  millis: u32,
}

fn now() -> Parts {
  let since = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
  from_unix_millis(since.as_millis() as i64)
}

/// Howard Hinnant's days-to-civil.
fn from_unix_millis(ms: i64) -> Parts {
  let secs = ms.div_euclid(1000);
  let days = secs.div_euclid(86_400);
  let rem = secs.rem_euclid(86_400);
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
  let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
  let year = yoe + era * 400 + i64::from(month <= 2);
  Parts {
    year,
    month,
    day,
    hour: (rem / 3600) as u32,
    minute: (rem % 3600 / 60) as u32,
    second: (rem % 60) as u32,
    millis: ms.rem_euclid(1000) as u32,
  }
}

fn iso(p: &Parts) -> String {
  format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", p.year, p.month, p.day, p.hour, p.minute, p.second, p.millis)
}

/// `2026-11-03T14:05:06.123Z`, as JavaScript's `toISOString`.
pub fn iso_now() -> String {
  iso(&now())
}

/// `20261103-140506`, the deployment export's default folder name.
pub fn compact_now() -> String {
  let p = now();
  format!("{:04}{:02}{:02}-{:02}{:02}{:02}", p.year, p.month, p.day, p.hour, p.minute, p.second)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn civil_dates() {
    assert_eq!(iso(&from_unix_millis(0)), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso(&from_unix_millis(1_793_716_521_912)), "2026-11-03T14:35:21.912Z");
    assert_eq!(iso(&from_unix_millis(951_782_400_000)), "2000-02-29T00:00:00.000Z");
  }
}
