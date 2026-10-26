//! Client-side DELIMITER directives are not SQL and are never sent to the server.
use crate::model::Error;
use sqlparser::{
    ast::{Expr, Query, SetExpr, Statement, Visit, Visitor},
    dialect::MySqlDialect,
    parser::Parser,
};
use std::ops::ControlFlow;
pub fn first_word(mut sql: &str) -> String {
    loop {
        sql = sql.trim_start();
        if sql.starts_with('#')
            || (sql.starts_with("--") && sql.as_bytes().get(2).is_none_or(u8::is_ascii_whitespace))
        {
            sql = sql.split_once('\n').map_or("", |(_, rest)| rest);
        } else if sql.starts_with("/*!") || sql.starts_with("/*M!") {
            return "EXECUTABLE".into();
        } else if sql.starts_with("/*") {
            sql = sql.split_once("*/").map_or("", |(_, rest)| rest);
        } else {
            break;
        }
    }
    sql.chars()
        .take_while(char::is_ascii_alphabetic)
        .collect::<String>()
        .to_ascii_uppercase()
}
pub fn statements(sql: &str) -> Result<Vec<String>, Error> {
    if sql.len() > 1024 * 1024 {
        return Err(Error::new("SQL_LIMIT", "SQL text is limited to 1 MiB."));
    }
    let b = sql.as_bytes();
    let (mut i, mut start) = (0, 0);
    let mut delimiter = ";".to_string();
    let mut out = Vec::new();
    let mut pending_sql = false;
    while i < b.len() {
        if (i == 0 || b[i - 1] == b'\n') && !pending_sql {
            let end = sql[i..].find('\n').map_or(b.len(), |n| i + n);
            let line = sql[i..end].trim();
            if line.to_ascii_uppercase().starts_with("DELIMITER ") {
                let d = line[10..].trim();
                if d.is_empty() || d.len() > 16 || d.chars().any(char::is_whitespace) {
                    return Err(Error::new(
                        "SQL_PARSE",
                        "Use a delimiter of 1–16 non-whitespace characters.",
                    ));
                }
                delimiter = d.into();
                i = end;
                start = end;
                continue;
            }
        }
        if b[i..].starts_with(delimiter.as_bytes()) {
            let s = sql[start..i].trim();
            if pending_sql {
                out.push(s.into());
            }
            i += delimiter.len();
            start = i;
            pending_sql = false;
            continue;
        }
        match b[i] {
            b'\'' | b'"' | b'`' => {
                pending_sql = true;
                let q = b[i];
                i += 1;
                loop {
                    if i >= b.len() {
                        return Err(Error::new(
                            "SQL_PARSE",
                            "Unterminated SQL string or identifier.",
                        ));
                    }
                    if b[i] == q {
                        i += 1;
                        if b.get(i) == Some(&q) {
                            i += 1;
                        } else {
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            b'#' => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'-' if b.get(i + 1) == Some(&b'-')
                && b.get(i + 2).is_none_or(u8::is_ascii_whitespace) =>
            {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                if b.get(i + 2) == Some(&b'!') || b.get(i + 2..i + 4) == Some(b"M!") {
                    pending_sql = true;
                }
                i += 2;
                while i + 1 < b.len() && &b[i..i + 2] != b"*/" {
                    i += 1;
                }
                if i + 1 >= b.len() {
                    return Err(Error::new("SQL_PARSE", "Unterminated SQL comment."));
                }
                i += 2;
            }
            _ => {
                if !b[i].is_ascii_whitespace() {
                    pending_sql = true;
                }
                i += 1;
            }
        }
    }
    let s = sql[start..].trim();
    if pending_sql {
        out.push(s.into());
    }
    if out.len() > 100 {
        return Err(Error::new(
            "SQL_LIMIT",
            "Scripts are limited to 100 statements.",
        ));
    }
    Ok(out)
}
struct ReadCheck;
impl Visitor for ReadCheck {
    type Break = ();
    fn pre_visit_query(&mut self, q: &Query) -> ControlFlow<()> {
        if matches!(q.body.as_ref(),SetExpr::Select(s) if s.into.is_some()) {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    }
    fn pre_visit_expr(&mut self, e: &Expr) -> ControlFlow<()> {
        if let Expr::Function(f) = e {
            let name = f.name.to_string().to_ascii_uppercase();
            if ![
                "COUNT",
                "SUM",
                "AVG",
                "MIN",
                "MAX",
                "COALESCE",
                "IFNULL",
                "NULLIF",
                "IF",
                "CONCAT",
                "CONCAT_WS",
                "UPPER",
                "LOWER",
                "LENGTH",
                "CHAR_LENGTH",
                "CHARACTER_LENGTH",
                "SUBSTRING",
                "SUBSTR",
                "TRIM",
                "ROUND",
                "ABS",
                "CEIL",
                "CEILING",
                "FLOOR",
                "JSON_EXTRACT",
                "JSON_UNQUOTE",
                "JSON_OBJECT",
                "JSON_ARRAY",
                "JSON_LENGTH",
                "JSON_TYPE",
                "DATABASE",
                "SCHEMA",
                "CONNECTION_ID",
                "VERSION",
                "NOW",
                "CURRENT_TIMESTAMP",
                "CURRENT_DATE",
                "DATE",
                "DATE_FORMAT",
                "CAST",
                "CONVERT",
                "GROUP_CONCAT",
                "FIND_IN_SET",
                "SUBSTRING_INDEX",
                "REPLACE",
                "SLEEP",
                "BENCHMARK",
                "ROW_NUMBER",
                "RANK",
                "DENSE_RANK",
                "LAG",
                "LEAD",
            ]
            .contains(&name.as_str())
            {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    }
    fn pre_visit_statement(&mut self, s: &Statement) -> ControlFlow<()> {
        if matches!(
            s,
            Statement::Insert(_) | Statement::Update { .. } | Statement::Delete(_)
        ) {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    }
}
pub fn validate(sql: &str, readonly: bool, confirmed: bool) -> Result<(), Error> {
    let word = first_word(sql);
    if ["LOAD", "INSTALL", "UNINSTALL", "SHUTDOWN"].contains(&word.as_str()) {
        return Err(Error::new(
            "SQL_UNSUPPORTED",
            "File loading, server plugins and shutdown are not exposed by this client.",
        ));
    }
    if readonly
        && [
            "BEGIN",
            "START TRANSACTION",
            "START TRANSACTION READ ONLY",
            "COMMIT",
            "ROLLBACK",
        ]
        .contains(
            &sql.trim()
                .trim_end_matches(';')
                .trim()
                .to_ascii_uppercase()
                .as_str(),
        )
    {
        return Ok(());
    }
    if readonly {
        if sql.contains("/*!") || sql.contains("/*M!") {
            return Err(Error::new(
                "READ_ONLY",
                "Executable comments are not allowed in read-only SQL.",
            ));
        }
        if !["SELECT", "WITH", "EXPLAIN", "SHOW", "VALUES"].contains(&word.as_str()) {
            return Err(Error::new(
                "READ_ONLY",
                "Enable write access explicitly before running this statement.",
            ));
        }
        // SHOW/EXPLAIN metadata are also enforced by read-only server transactions.
        {
            let parsed = Parser::parse_sql(&MySqlDialect {}, sql).map_err(|_| {
                Error::new("READ_ONLY", "This statement could not be proven read-only.")
            })?;
            if parsed.len() != 1
                || (!matches!(word.as_str(), "SHOW" | "EXPLAIN")
                    && !matches!(parsed.first(),Some(Statement::Query(q)) if matches!(q.body.as_ref(),SetExpr::Select(_)|SetExpr::Query(_)|SetExpr::SetOperation{..}|SetExpr::Values(_))))
                || parsed.visit(&mut ReadCheck).is_break()
            {
                return Err(Error::new(
                    "READ_ONLY",
                    "This query can have side effects and is blocked in read-only mode.",
                ));
            }
        }
    } else if !confirmed && (sql.contains("/*!") || sql.contains("/*M!")) {
        return Err(Error::new(
            "CONFIRM_REQUIRED",
            "Review executable comments before running this SQL.",
        ));
    } else if !confirmed
        && ![
            "SELECT",
            "SHOW",
            "VALUES",
            "EXPLAIN",
            "BEGIN",
            "START",
            "ROLLBACK",
            "SAVEPOINT",
            "RELEASE",
        ]
        .contains(&word.as_str())
    {
        return Err(Error::new(
            "CONFIRM_REQUIRED",
            "Review this exact SQL before executing it. DDL and routines may commit implicitly and cannot be undone automatically.",
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routine_delimiters_and_literals() {
        let parts=statements("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT ';'; SELECT 2; END$$\nDELIMITER ;\nCALL p();").unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(statements("-- routine script\n# a comment\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$").unwrap().len(), 1);
        assert!(parts[0].contains("SELECT ';'; SELECT 2;"));
        assert_eq!(parts[1], "CALL p()");
    }
    #[test]
    fn readonly_and_reviews() {
        assert!(validate("SELECT 1", true, false).is_ok());
        assert_eq!(
            first_word("# dialect comment\n/* metadata */ CREATE TABLE t(id INT)"),
            "CREATE"
        );
        assert!(validate("# read comment\nSELECT 1", true, false).is_ok());
        for sql in [
            "CALL p()",
            "DROP TABLE t",
            "SELECT custom_function()",
            "SELECT 1 INTO OUTFILE '/tmp/x'",
            "WITH x AS (SELECT 1) DELETE FROM t",
        ] {
            assert!(validate(sql, true, true).is_err());
        }
        assert!(validate("DROP TABLE t", false, false).is_err());
        assert!(validate("DROP TABLE t", false, true).is_ok());
    }
}
