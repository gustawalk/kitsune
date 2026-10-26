use crate::model::Error;

pub fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}
// Lex only to delimit statements and classify safety. The database remains the parser
// and read-only enforcement boundary. Strings, comments and dollar quotes are opaque.
pub fn statements(sql: &str) -> Result<Vec<String>, Error> {
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut start = 0;
    let mut result = Vec::new();
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => {
                let q = bytes[i];
                let escaped = q == b'\''
                    && i > 0
                    && matches!(bytes[i - 1], b'E' | b'e')
                    && (i < 2 || !(bytes[i - 2].is_ascii_alphanumeric() || bytes[i - 2] == b'_'));
                i += 1;
                loop {
                    if i >= bytes.len() {
                        return Err(Error::new(
                            "SQL_PARSE",
                            "Unterminated SQL string or identifier.",
                        ));
                    }
                    if escaped && bytes[i] == b'\\' {
                        i = (i + 2).min(bytes.len());
                        continue;
                    }
                    if bytes[i] == q {
                        i += 1;
                        if i < bytes.len() && bytes[i] == q {
                            i += 1;
                        } else {
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            b'[' => {
                i += 1;
                while i < bytes.len() && bytes[i] != b']' {
                    i += 1;
                }
                if i == bytes.len() {
                    return Err(Error::new("SQL_PARSE", "Unterminated identifier."));
                }
                i += 1;
            }
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                let mut depth = 1;
                while i < bytes.len() && depth > 0 {
                    if bytes.get(i..i + 2) == Some(b"/*") {
                        depth += 1;
                        i += 2;
                    } else if bytes.get(i..i + 2) == Some(b"*/") {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                if depth > 0 {
                    return Err(Error::new("SQL_PARSE", "Unterminated comment."));
                }
            }
            b'$' => {
                let mut end = i + 1;
                while end < bytes.len()
                    && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_')
                {
                    end += 1;
                }
                if bytes.get(end) == Some(&b'$') {
                    let tag = &sql[i..=end];
                    let rest = &sql[end + 1..];
                    let close = rest.find(tag).ok_or_else(|| {
                        Error::new("SQL_PARSE", "Unterminated dollar-quoted string.")
                    })?;
                    i = end + 1 + close + tag.len();
                } else {
                    i += 1;
                }
            }
            b';' => {
                let s = sql[start..i].trim();
                if !s.is_empty() && !first_word(s).is_empty() {
                    result.push(s.into());
                }
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    let s = sql[start..].trim();
    if !s.is_empty() && !first_word(s).is_empty() {
        result.push(s.into());
    }
    Ok(result)
}
pub fn first_word(sql: &str) -> String {
    let mut s = sql.trim_start();
    loop {
        if s.starts_with("--") {
            s = s.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if s.starts_with("/*") {
            let bytes = s.as_bytes();
            let mut i = 2;
            let mut depth = 1;
            while i < bytes.len() && depth > 0 {
                if bytes.get(i..i + 2) == Some(b"/*") {
                    depth += 1;
                    i += 2;
                } else if bytes.get(i..i + 2) == Some(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            s = s.get(i..).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    s.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_uppercase()
}
pub fn validate_sql(sql: &str, read_only: bool, confirmed: bool) -> Result<String, Error> {
    let statements = statements(sql)?;
    if statements.len() != 1 {
        return Err(Error::new(
            "SQL_STATEMENTS",
            "Execute one statement, or select explicit sequential script mode.",
        ));
    }
    let statement = statements[0].clone();
    let word = first_word(&statement);
    if [
        "BEGIN",
        "START",
        "COMMIT",
        "END",
        "ROLLBACK",
        "SAVEPOINT",
        "RELEASE",
        "SET",
        "RESET",
        "DISCARD",
        "ATTACH",
        "DETACH",
        "PRAGMA",
        "LOAD",
        "COPY",
        "VACUUM",
        "PREPARE",
        "EXECUTE",
        "DEALLOCATE",
    ]
    .contains(&word.as_str())
    {
        return Err(Error::new(
            "SQL_UNSUPPORTED",
            "Transaction/session control and external-file operations are not supported in the managed SQL editor.",
        ));
    }
    if read_only && !["SELECT", "WITH", "VALUES", "EXPLAIN", "SHOW"].contains(&word.as_str()) {
        return Err(Error::new(
            "READ_ONLY",
            "This connection is read-only. Enable session writes explicitly to execute this statement.",
        ));
    }
    if !read_only && !["SELECT", "VALUES", "SHOW", "INSERT"].contains(&word.as_str()) && !confirmed
    {
        return Err(Error::new(
            "CONFIRM_REQUIRED",
            "Review and confirm this exact SQL statement before execution.",
        ));
    }
    Ok(statement)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_are_escaped() {
        assert_eq!(quote("a\"b"), "\"a\"\"b\"");
    }
    #[test]
    fn split_dialect_strings() {
        assert_eq!(
            statements("select ';'; select $$a;b$$; -- hello\n select 3")
                .unwrap()
                .len(),
            3
        );
        assert!(statements("select 'broken").is_err());
    }
    #[test]
    fn nested_comments_cannot_bypass_guard() {
        assert_eq!(first_word("/* a /* b */ c */ DELETE FROM a"), "DELETE");
        assert!(validate_sql("/*hello*/DELETE FROM a", true, true).is_err());
    }
    #[test]
    fn denies_bypasses_and_requires_review() {
        for s in [
            "COMMIT",
            "SET transaction_read_only=off",
            "ATTACH 'x' AS b",
            "select 1; delete from a",
        ] {
            assert!(validate_sql(s, true, true).is_err());
        }
        assert!(validate_sql("WITH x AS (SELECT 1) SELECT * FROM x", false, false).is_err());
        assert!(validate_sql("DROP TABLE a", false, true).is_ok());
    }
}
#[cfg(test)]
mod escaped_strings {
    use super::*;
    #[test]
    fn postgres_escaped_quotes_do_not_split_statements() {
        assert_eq!(
            statements(r"SELECT E'it\'s;safe'; SELECT 2").unwrap().len(),
            2
        );
    }
}
