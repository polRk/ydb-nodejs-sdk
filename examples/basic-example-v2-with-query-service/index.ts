import {Column, Driver, getCredentialsFromEnv, Logger, TableDescription, TableIndex, Types, RowType} from 'ydb-sdk';
import {Episode, getEpisodesData, getSeasonsData, getSeriesData, Series} from './data-helpers';
import {main} from '../utils';

process.env.YDB_SDK_PRETTY_LOGS = '1';

const SERIES_TABLE = 'series';
const SEASONS_TABLE = 'seasons';
const EPISODES_TABLE = 'episodes';

async function createTables(driver: Driver, logger: Logger) {
    logger.info('Dropping old tables...');

    await driver.tableClient.withSessionRetry(async (session) => {
        await session.dropTable(SERIES_TABLE);
        await session.dropTable(EPISODES_TABLE);
        await session.dropTable(SEASONS_TABLE);
    });

    logger.info('Creating tables...');
    await driver.tableClient.withSessionRetry(async (session) => {
        await session.createTable(
            SERIES_TABLE,
            new TableDescription()
                .withColumn(new Column(
                    'series_id',
                    Types.optional(Types.UINT64),
                ))
                .withColumn(new Column(
                    'title',
                    Types.optional(Types.UTF8),
                ))
                .withColumn(new Column(
                    'series_info',
                    Types.optional(Types.UTF8),
                ))
                .withColumn(new Column(
                    'release_date',
                    Types.optional(Types.DATE),
                ))
                .withPrimaryKey('series_id')
        );

        await session.createTable(
            SEASONS_TABLE,
            new TableDescription()
                .withColumn(new Column(
                    'series_id',
                    Types.optional(Types.UINT64),
                ))
                .withColumn(new Column(
                    'season_id',
                    Types.optional(Types.UINT64),
                ))
                .withColumn(new Column(
                    'title',
                    Types.optional(Types.UTF8),
                ))
                .withColumn(new Column(
                    'first_aired',
                    Types.optional(Types.DATE),
                ))
                .withColumn(new Column(
                    'last_aired',
                    Types.optional(Types.DATE),
                ))
                .withPrimaryKeys('series_id', 'season_id')
        );

        const episodesIndex = new TableIndex('episodes_index')
            .withIndexColumns('title')
            .withDataColumns('air_date')
            .withGlobalAsync(true)

        await session.createTable(
            EPISODES_TABLE,
            new TableDescription()
                .withColumn(new Column(
                    'series_id',
                    Types.optional(Types.UINT64),
                ))
                .withColumn(new Column(
                    'season_id',
                    Types.optional(Types.UINT64),
                ))
                .withColumn(new Column(
                    'episode_id',
                    Types.optional(Types.UINT64),
                ))
                .withColumn(new Column(
                    'title',
                    Types.optional(Types.UTF8),
                ))
                .withColumn(new Column(
                    'air_date',
                    Types.optional(Types.DATE),
                ))
                .withPrimaryKeys('series_id', 'season_id', 'episode_id')
                .withIndex(episodesIndex)
        );
    });
}

// TODO: Returns {"issues":[{"message":"Scheme operation failed, status: ExecComplete, reason: Check failed: path: '/local/seasons', error: path exist, request accepts it (id: [OwnerId: 72075186232723360, LocalPathId: 6], type: EPathTypeTable, state: EPathStateNoChanges)","severity":1}]}

// async function createTables(driver: Driver, logger: Logger) {
//     logger.info('Dropping old tables and create new ones...');
//
//     await driver.queryClient.do({
//         fn: async (session) => {
//             await session.execute({
//                 text: `
//                     DROP TABLE IF EXISTS ${SERIES_TABLE};
//                     DROP TABLE IF EXISTS ${EPISODES_TABLE};
//                     DROP TABLE IF EXISTS ${SEASONS_TABLE};`,
//             });
//         },
//     });
//
//     await driver.queryClient.do({
//         fn: async (session) => {
//             await session.execute({
//                 text: `
//                     CREATE TABLE ${SERIES_TABLE}
//                     (
//                         series_id    UInt64,
//                         title        Utf8,
//                         series_info  Utf8,
//                         release_date DATE,
//                         PRIMARY KEY (series_id)
//                     );
//
//                     CREATE TABLE ${SEASONS_TABLE}
//                     (
//                         series_id   UInt64,
//                         season_id   UInt64,
//                         first_aired DATE,
//                         PRIMARY KEY (series_id, season_id)
//                     );
//
//                     CREATE TABLE ${SEASONS_TABLE}
//                     (
//                         series_id   UInt64,
//                         season_id   UInt64,
//                         first_aired DATE,
//                         PRIMARY KEY (series_id, season_id)
//                     );
//
//                     CREATE TABLE ${EPISODES_TABLE}
//                     (
//                         series_id  UInt64,
//                         season_id  UInt64,
//                         episode_id UInt64,
//                         title      Utf8,
//                         air_date   DATE,
//                         PRIMARY KEY (series_id, season_id),
//                         INDEX      episodes_index GLOBAL ASYNC ON (air_date)
//                     );`,
//             });
//         },
//     });
// }

async function describeTable(driver: Driver, tableName: string, logger: Logger) {
    logger.info(`Describing table: ${tableName}`);
    const result = await driver.tableClient.withSessionRetry(
        (session) => session.describeTable(tableName));
    for (const column of result.columns) {
        logger.info(`Column name '${column.name}' has type ${JSON.stringify(column.type)}`);
    }
}

async function selectSimple(driver: Driver, logger: Logger): Promise<void> {
    logger.info('Making a simple select...');
    const result = await driver.queryClient.do({
        fn: async (session) => {
            const {resultSets} =
                await session.execute({
                    rowMode: RowType.Ydb, // enables typedRows() on result sets
                    text: `
                        SELECT series_id,
                               title,
                               release_date
                        FROM ${SERIES_TABLE}
                        WHERE series_id = 1;`,
                });
            const {value: resultSet1} = await resultSets.next();
            const rows: Series[] = []
            for await (const row of resultSet1.typedRows(Series)) rows.push(row);
            return rows;
        }
    });
    logger.info(`selectSimple result: ${JSON.stringify(result, null, 2)}`);
}

async function upsertSimple(driver: Driver, logger: Logger): Promise<void> {
    logger.info('Making an upsert...');
    await driver.queryClient.do({
        fn: async (session) => {
            await session.execute({
                text: `
                    UPSERT INTO ${EPISODES_TABLE} (series_id, season_id, episode_id, title)
                    VALUES (2, 6, 1, "TBD");`,
            })
        }
    });
    logger.info('Upsert completed.')
}

type ThreeIds = [number, number, number];

// TODO: Add native version
async function selectPrepared(driver: Driver, data: ThreeIds[], logger: Logger): Promise<void> {
    logger.info('Selecting prepared query...');
    await driver.queryClient.do({
        fn: async (session) => {
            for (const [seriesId, seasonId, episodeId] of data) {
                const episode = new Episode({seriesId, seasonId, episodeId, title: '', airDate: new Date()});

                // Note: In query service execute() there is no "prepared query" option.
                //       This behaviour applied by YDB according to an internal rule

                console.info(2000, session.sessionId);
                const {resultSets} = await session.execute({
                    parameters: {
                        '$seriesId': episode.getTypedValue('seriesId'),
                        '$seasonId': episode.getTypedValue('seasonId'),
                        '$episodeId': episode.getTypedValue('episodeId')
                    },
                    text: `
                        SELECT title,
                               air_date
                        FROM episodes
                        WHERE series_id = $seriesId
                          AND season_id = $seasonId
                          AND episode_id = $episodeId;`
                });
                const {value: resultSet} = await resultSets.next();
                const {value: row} = await resultSet.rows.next();
                logger.info(`Select prepared query ${JSON.stringify(row, null, 2)}`);
            }
        }
    });
}

// TODO: Add doTx
async function explicitTcl(driver: Driver, ids: ThreeIds, logger: Logger) {
    logger.info('Running prepared query with explicit transaction control...');
    await driver.queryClient.do({
        fn: async (session) => {
            await session.beginTransaction({serializableReadWrite: {}});
            const [seriesId, seasonId, episodeId] = ids;
            const episode = new Episode({seriesId, seasonId, episodeId, title: '', airDate: new Date()});
            await session.execute({
                parameters: {
                    '$seriesId': episode.getTypedValue('seriesId'),
                    '$seasonId': episode.getTypedValue('seasonId'),
                    '$episodeId': episode.getTypedValue('episodeId')
                },
                text: `
                    UPDATE episodes
                    SET air_date = CurrentUtcDate()
                    WHERE series_id = $seriesId
                      AND season_id = $seasonId
                      AND episode_id = $episodeId;`
            })
            const txId = session.txId;
            await session.commitTransaction();
            logger.info(`TxId ${txId} committed.`);
        }
    });
}

// @ts-ignore
async function fillTablesWithData(driver: Driver, _logger: Logger) {
    await driver.queryClient.do({
        fn: async (session) => {
            await session.execute({
                parameters: {
                    '$seriesData': getSeriesData(),
                    '$seasonsData': getSeasonsData(),
                    '$episodesData': getEpisodesData()
                },
                text: `
                    REPLACE
                    INTO
                    ${SERIES_TABLE}
                    SELECT series_id,
                           title,
                           series_info,
                           release_date
                    FROM AS_TABLE($seriesData);

                    REPLACE
                    INTO
                    ${SEASONS_TABLE}
                    SELECT series_id,
                           season_id,
                           title,
                           first_aired,
                           last_aired
                    FROM AS_TABLE($seasonsData);

                    REPLACE
                    INTO
                    ${EPISODES_TABLE}
                    SELECT series_id,
                           season_id,
                           episode_id,
                           title,
                           air_date
                    FROM AS_TABLE($episodesData);`
            });
        }
    });
}

async function run(logger: Logger, endpoint: string, database: string) {
    const authService = getCredentialsFromEnv();
    logger.debug('Driver initializing...');
    const driver = new Driver({endpoint, database, authService});
    const timeout = 10000;
    try {
        if (!await driver.ready(timeout)) {
            logger.fatal(`Driver has not become ready in ${timeout}ms!`);
            process.exit(1);
        }

        await createTables(driver, logger);
        await describeTable(driver, SERIES_TABLE, logger);
        await fillTablesWithData(driver, logger);

        await selectSimple(driver, logger);
        await upsertSimple(driver, logger);

        // TODO: Fix
        // await selectPrepared(driver, [[2, 3, 7], [2, 3, 8]], logger);

        await explicitTcl(driver, [2, 6, 1], logger);
        await selectPrepared(driver, [[2, 6, 1]], logger);

    } catch (err) {
        console.error(err);
    } finally {
        await driver.destroy();
    }
}

main(run);
