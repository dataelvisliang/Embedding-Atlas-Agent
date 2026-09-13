import { createRequire } from 'node:module';
import path from 'node:path';
import * as duckdb from '@duckdb/duckdb-wasm/blocking';

import type { QueryCoordinator } from '../src/tools/toolExecutor';

const require = createRequire(import.meta.url);

let coordinatorPromise: Promise<QueryCoordinator> | undefined;

function parquetPath(): string {
    return process.env.ATLAS_PARQUET_PATH || path.join(process.cwd(), 'public', 'atlas', 'data', 'dataset.parquet');
}

function sqlPath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/'/g, "''");
}

/**
 * The Node build of DuckDB-WASM keeps tool SQL identical to the browser path.
 * A function instance reuses this singleton connection for warm invocations.
 */
async function createCoordinator(): Promise<QueryCoordinator> {
    const bundles = {
        mvp: {
            mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm'),
            mainWorker: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-mvp.worker.cjs')
        },
        eh: {
            mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'),
            mainWorker: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-eh.worker.cjs')
        }
    };
    const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await db.instantiate();
    const connection = db.connect();
    await connection.query(`CREATE OR REPLACE VIEW reviews AS SELECT * FROM read_parquet('${sqlPath(parquetPath())}')`);
    return {
        async query(sql: string) {
            return connection.query(sql);
        }
    };
}

export function getServerCoordinator(): Promise<QueryCoordinator> {
    coordinatorPromise ||= createCoordinator();
    return coordinatorPromise;
}
