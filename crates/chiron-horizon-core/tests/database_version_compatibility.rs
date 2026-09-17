use std::time::Duration;

use chiron_horizon_core::db::{mysql, postgres};
use mysql_async::prelude::Queryable;

fn unique_table(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

#[tokio::test]
#[ignore = "requires CHIRON_HORIZON_COMPAT_POSTGRES_URL pointing at the monitored PostgreSQL recipe"]
async fn postgresql_version_monitor_crud() {
    let url = std::env::var("CHIRON_HORIZON_COMPAT_POSTGRES_URL").expect("CHIRON_HORIZON_COMPAT_POSTGRES_URL");
    let pool = postgres::connect(&url, Duration::from_secs(10)).await.expect("connect through Chiron Horizon PostgreSQL driver");
    let table = unique_table("chiron_horizon_version_monitor");

    postgres::execute_query(&pool, &format!("CREATE TABLE {table} (id integer PRIMARY KEY, note text NOT NULL)"))
        .await
        .expect("create table");
    let result = async {
        postgres::execute_query(&pool, &format!("INSERT INTO {table} VALUES (1, 'created')")).await?;
        postgres::execute_query(&pool, &format!("UPDATE {table} SET note = 'updated' WHERE id = 1")).await?;
        postgres::execute_batch(
            &pool,
            &["BEGIN".to_string(), format!("INSERT INTO {table} VALUES (2, 'rollback')"), "ROLLBACK".to_string()],
        )
        .await?;
        let rolled_back =
            postgres::execute_query(&pool, &format!("SELECT count(*) AS count FROM {table} WHERE id = 2")).await?;
        if rolled_back.rows != vec![vec![serde_json::json!(0)]] {
            return Err("PostgreSQL rollback did not discard its row".to_string());
        }
        let tables = postgres::list_tables(&pool, "public").await?;
        if !tables.iter().any(|item| item.name == table) {
            return Err("created PostgreSQL table was not discovered".to_string());
        }
        let selected = postgres::execute_query(&pool, &format!("SELECT note FROM {table} WHERE id = 1")).await?;
        if selected.rows != vec![vec![serde_json::json!("updated")]] {
            return Err("PostgreSQL read did not return the updated row".to_string());
        }
        postgres::execute_query(&pool, &format!("DELETE FROM {table} WHERE id = 1")).await?;
        Ok::<(), String>(())
    }
    .await;
    let cleanup = postgres::execute_query(&pool, &format!("DROP TABLE IF EXISTS {table}")).await;
    pool.close();
    result.expect("exercise PostgreSQL CRUD and metadata through Chiron Horizon");
    cleanup.expect("drop PostgreSQL compatibility table");
}

#[tokio::test]
#[ignore = "requires CHIRON_HORIZON_COMPAT_MYSQL_URL pointing at the monitored MySQL recipe"]
async fn mysql_version_monitor_crud() {
    let url = std::env::var("CHIRON_HORIZON_COMPAT_MYSQL_URL").expect("CHIRON_HORIZON_COMPAT_MYSQL_URL");
    let pool = mysql::connect(&url, Duration::from_secs(10)).await.expect("connect through Chiron Horizon MySQL driver");
    let table = unique_table("chiron_horizon_version_monitor");

    mysql::execute_query(
        &pool,
        &format!("CREATE TABLE `{table}` (id integer PRIMARY KEY, note varchar(255) NOT NULL)"),
        false,
    )
    .await
    .expect("create table");
    let result = async {
        mysql::execute_query(&pool, &format!("INSERT INTO `{table}` VALUES (1, 'created')"), false).await?;
        mysql::execute_query(&pool, &format!("UPDATE `{table}` SET note = 'updated' WHERE id = 1"), false).await?;
        let mut transaction = mysql::get_conn_with_health_check(&pool).await?;
        transaction.query_drop("START TRANSACTION").await.map_err(|error| error.to_string())?;
        transaction
            .query_drop(format!("INSERT INTO `{table}` VALUES (2, 'rollback')"))
            .await
            .map_err(|error| error.to_string())?;
        transaction.query_drop("ROLLBACK").await.map_err(|error| error.to_string())?;
        drop(transaction);
        let rolled_back =
            mysql::execute_query(&pool, &format!("SELECT count(*) AS count FROM `{table}` WHERE id = 2"), false)
                .await?;
        if rolled_back.rows != vec![vec![serde_json::json!("0")]] {
            return Err("MySQL rollback did not discard its row".to_string());
        }
        let tables = mysql::list_tables(&pool, "chiron-horizon").await?;
        if !tables.iter().any(|item| item.name == table) {
            return Err("created MySQL table was not discovered".to_string());
        }
        let selected = mysql::execute_query(&pool, &format!("SELECT note FROM `{table}` WHERE id = 1"), false).await?;
        if selected.rows != vec![vec![serde_json::json!("updated")]] {
            return Err("MySQL read did not return the updated row".to_string());
        }
        mysql::execute_query(&pool, &format!("DELETE FROM `{table}` WHERE id = 1"), false).await?;
        Ok::<(), String>(())
    }
    .await;
    let cleanup = mysql::execute_query(&pool, &format!("DROP TABLE IF EXISTS `{table}`"), false).await;
    pool.disconnect().await.expect("disconnect MySQL compatibility pool");
    result.expect("exercise MySQL CRUD and metadata through Chiron Horizon");
    cleanup.expect("drop MySQL compatibility table");
}
