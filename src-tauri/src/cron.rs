//! cron.rs -- 标准 5 字段 cron(分 时 日 月 周)解析与下次执行时间
//! 支持 `*`、数字、区间 `a-b`、步长 `*/n` 与 `a/n`、逗号组合;周字段 0/7 均为周日。
//! 日与周同时受限时按标准语义取"或"(任一匹配即触发)。不引入第三方依赖。

use time::{Date, Month, OffsetDateTime, Time};

const FIELD_RANGES: [(&str, u32, u32); 5] = [
    ("分钟", 0, 59),
    ("小时", 0, 23),
    ("日", 1, 31),
    ("月", 1, 12),
    ("周", 0, 7),
];

#[derive(Debug, Clone)]
pub struct Cron {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days: Vec<u32>,
    months: Vec<u32>,
    weekdays: Vec<u32>,
    day_restricted: bool,
    weekday_restricted: bool,
}

fn parse_field(text: &str, name: &str, min: u32, max: u32) -> Result<Vec<u32>, String> {
    let mut values: Vec<u32> = Vec::new();
    let mut push = |value: u32| {
        if !values.contains(&value) {
            values.push(value);
        }
    };
    if text.trim().is_empty() {
        return Err("cron 字段为空".into());
    }
    for part in text.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err("cron 字段为空".into());
        }
        let (base, step) = match part.split_once('/') {
            Some((base, step)) => {
                let step: u32 = step.parse().map_err(|_| format!("cron 步长非法: {part}"))?;
                if step == 0 {
                    return Err(format!("cron 步长非法: {part}"));
                }
                (base, Some(step))
            }
            None => (part, None),
        };
        let (start, end) = if base == "*" {
            (min, max)
        } else if let Some((a, b)) = base.split_once('-') {
            let start: u32 = a.parse().map_err(|_| format!("cron 区间非法: {part}"))?;
            let end: u32 = b.parse().map_err(|_| format!("cron 区间非法: {part}"))?;
            (start, end)
        } else {
            let start: u32 = base.parse().map_err(|_| format!("cron 数值非法: {part}"))?;
            (start, if step.is_some() { max } else { start })
        };
        if start < min || end > max || start > end {
            return Err(format!("cron {name}超出范围({min}-{max}): {part}"));
        }
        let step = step.unwrap_or(1);
        let mut value = start;
        while value <= end {
            push(value);
            value += step;
        }
    }
    values.sort_unstable();
    Ok(values)
}

/// 解析表达式;字段数必须为 5。
pub fn parse(expression: &str) -> Result<Cron, String> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        return Err("cron 需要 5 个字段(分 时 日 月 周)".into());
    }
    let mut parsed = Vec::with_capacity(5);
    for (index, field) in fields.iter().enumerate() {
        let (name, min, max) = FIELD_RANGES[index];
        parsed.push(parse_field(field, name, min, max)?);
    }
    let weekdays = parsed[4]
        .iter()
        .map(|value| if *value == 7 { 0 } else { *value })
        .collect::<Vec<u32>>();
    Ok(Cron {
        minutes: parsed[0].clone(),
        hours: parsed[1].clone(),
        days: parsed[2].clone(),
        months: parsed[3].clone(),
        weekdays,
        day_restricted: fields[2].trim() != "*",
        weekday_restricted: fields[4].trim() != "*",
    })
}

fn matches_day(cron: &Cron, date: Date) -> bool {
    let month = date.month() as u32;
    if !cron.months.contains(&month) {
        return false;
    }
    let day_ok = cron.days.contains(&(date.day() as u32));
    let weekday_ok = cron.weekdays.contains(&(date.weekday().number_days_from_sunday() as u32));
    match (cron.day_restricted, cron.weekday_restricted) {
        (true, true) => day_ok || weekday_ok,
        (true, false) => day_ok,
        (false, true) => weekday_ok,
        (false, false) => true,
    }
}

/// 下一次执行时间(UTC,秒与毫秒归零);四年内无匹配返回 None。
pub fn next_run(expression: &str, from: OffsetDateTime) -> Result<Option<OffsetDateTime>, String> {
    let cron = parse(expression)?;
    let base = from.replace_nanosecond(0).unwrap_or(from);
    let start = base + time::Duration::minutes(1);
    let mut date = start.date();
    for _ in 0..=(366 * 4) {
        if matches_day(&cron, date) {
            for hour in &cron.hours {
                for minute in &cron.minutes {
                    let Some(time) = Time::from_hms(*hour as u8, *minute as u8, 0).ok() else {
                        continue;
                    };
                    let candidate = OffsetDateTime::new_utc(date, time);
                    if candidate >= start {
                        return Ok(Some(candidate));
                    }
                }
            }
        }
        date = match date.next_day() {
            Some(next) => next,
            None => break,
        };
    }
    Ok(None)
}

/// 便于测试/展示:格式化到分钟。
pub fn format_minute(value: OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute()
    )
}

#[allow(dead_code)]
fn _month_guard(_: Month) {}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn parses_fields_and_steps() {
        let cron = parse("*/5 9-11 * * 1-5").unwrap();
        assert_eq!(cron.minutes, vec![0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
        assert_eq!(cron.hours, vec![9, 10, 11]);
        assert_eq!(cron.weekdays, vec![1, 2, 3, 4, 5]);
        assert!(cron.day_restricted == false);
        assert!(cron.weekday_restricted);
        // 7 归一为周日
        assert_eq!(parse("0 0 * * 7").unwrap().weekdays, vec![0]);
        // 逗号组合
        assert_eq!(parse("0 9,18 * * *").unwrap().hours, vec![9, 18]);
    }

    #[test]
    fn rejects_invalid_expressions() {
        assert!(parse("* * * *").unwrap_err().contains("5 个字段"));
        assert!(parse("60 * * * *").unwrap_err().contains("分钟超出范围"));
        assert!(parse("* 24 * * *").unwrap_err().contains("小时超出范围"));
        assert!(parse("*/0 * * * *").unwrap_err().contains("步长非法"));
        assert!(parse("a * * * *").unwrap_err().contains("数值非法"));
        assert!(parse("5-1 * * * *").unwrap_err().contains("超出范围"));
    }

    #[test]
    fn computes_next_minute_aligned_with_offset() {
        let from = datetime!(2026-01-01 10:03:20 UTC);
        let next = next_run("*/5 * * * *", from).unwrap().unwrap();
        assert_eq!(format_minute(next), "2026-01-01 10:05");
        // 恰在整点:跳过当前分钟
        let on_the_hour = next_run("0 * * * *", datetime!(2026-01-01 10:00:00 UTC)).unwrap().unwrap();
        assert_eq!(format_minute(on_the_hour), "2026-01-01 11:00");
        // 每天 9:00
        assert_eq!(
            format_minute(next_run("0 9 * * *", datetime!(2026-01-01 09:00:00 UTC)).unwrap().unwrap()),
            "2026-01-02 09:00"
        );
    }

    #[test]
    fn handles_weekdays_month_boundary_and_impossible_dates() {
        // 2026-01-02 是周五 -> 工作日 9:00 下一次为周一
        let monday = next_run("0 9 * * 1-5", datetime!(2026-01-02 10:00:00 UTC)).unwrap().unwrap();
        assert_eq!(format_minute(monday), "2026-01-05 09:00");
        // 每月 1 日
        let next_month = next_run("0 0 1 * *", datetime!(2026-01-01 00:00:00 UTC)).unwrap().unwrap();
        assert_eq!(format_minute(next_month), "2026-02-01 00:00");
        // 2 月 30 日不存在 -> 四年内无匹配
        assert!(next_run("0 0 30 2 *", datetime!(2026-01-01 00:00:00 UTC)).unwrap().is_none());
    }

    #[test]
    fn day_and_weekday_restricted_use_or_semantics() {
        // 每月 15 日 或 每周一 00:00
        let first = next_run("0 0 15 * 1", datetime!(2026-01-13 00:00:00 UTC)).unwrap().unwrap();
        assert_eq!(format_minute(first), "2026-01-15 00:00");
        let second = next_run("0 0 15 * 1", datetime!(2026-01-16 00:00:00 UTC)).unwrap().unwrap();
        assert_eq!(format_minute(second), "2026-01-19 00:00");
    }
}
