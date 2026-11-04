/**
 * 过渡期转发：M1 起 DDL 的唯一来源是 src/host/schema.ts。
 *
 * migrate.ts 与既有测试仍从本模块取 SCHEMA_VERSION / SCHEMA_SQL / INDEX_SQL / tableDdl，
 * 因此这里只做 re-export，不再持有任何 DDL。
 */
export * from '../../host/schema'
