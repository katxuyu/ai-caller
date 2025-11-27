import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants for database paths
const TOKEN_DB_PATH = process.env.SQLITE_TOKEN_DB_PATH || path.join(__dirname, 'token.db');

let tokenInitializationPromise = null;

// Function to open token DB connection
export function openTokenDb() {
	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(TOKEN_DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
			if (err) {
				console.error('[TOKEN_DB] Error opening token database', err.message);
				reject(err);
			} else {
				resolve(db);
			}
		});
	});
}

// Function to close token DB connection
export function closeTokenDb(db) {
	return new Promise((resolve, reject) => {
		if (db) {
			db.close((err) => {
				if (err) {
					console.error('[TOKEN_DB] Error closing token database', err.message);
					reject(err);
				} else {
					resolve();
				}
			});
		} else {
			resolve();
		}
	});
}

// Promisify db operations for token database
export function runToken(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function (err) {
			if (err) {
				console.error('[TOKEN_DB] Error running sql: ', sql);
				console.error('[TOKEN_DB] Params: ', params);
				console.error('[TOKEN_DB] Error: ', err);
				reject(err);
			} else {
				resolve({ lastID: this.lastID, changes: this.changes });
			}
		});
	});
}

export function getToken(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.get(sql, params, (err, result) => {
			if (err) {
				console.error('[TOKEN_DB] Error running sql: ', sql);
				console.error('[TOKEN_DB] Params: ', params);
				console.error('[TOKEN_DB] Error: ', err);
				reject(err);
			} else {
				resolve(result);
			}
		});
	});
}

export function allTokens(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => {
			if (err) {
				console.error('[TOKEN_DB] Error running sql: ', sql);
				console.error('[TOKEN_DB] Params: ', params);
				console.error('[TOKEN_DB] Error: ', err);
				reject(err);
			} else {
				resolve(rows);
			}
		});
	});
}

// Initialize token database with token-related tables
export async function initializeTokenDatabase() {
	if (tokenInitializationPromise) {
		return tokenInitializationPromise;
	}

	tokenInitializationPromise = (async () => {
		let db;
		try {
			console.log("[TOKEN_DB] Initializing token database...");
			db = await openTokenDb();
			
			// GoHighLevel tokens table
			await runToken(db, `CREATE TABLE IF NOT EXISTS gohighlevel_tokens (
				location_id TEXT PRIMARY KEY NOT NULL,
				access_token TEXT NOT NULL,
				refresh_token TEXT NOT NULL,
				expires_at TEXT,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP
			)`);
			console.log("[TOKEN_DB] gohighlevel_tokens table checked/created successfully.");

			// Slack installation tokens table
			await runToken(db, `CREATE TABLE IF NOT EXISTS slack_installation_tokens (
				team_id TEXT PRIMARY KEY NOT NULL,
				app_id TEXT,
				bot_user_id TEXT,
				bot_access_token TEXT NOT NULL,
				bot_scope TEXT,
				token_type TEXT,
				enterprise_id TEXT,
				authed_user_id TEXT,
				is_enterprise_install BOOLEAN,
				token_details_json TEXT,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
			)`);
			console.log("[TOKEN_DB] slack_installation_tokens table checked/created successfully.");

		} catch (error) {
			console.error("[TOKEN_DB] Error initializing token database:", error);
			tokenInitializationPromise = null; // Reset on error
			throw error;
		} finally {
			if (db) await closeTokenDb(db);
		}
	})();

	return tokenInitializationPromise;
}

// Initialize token database on module load
(async () => {
	console.log(`Token database path: ${TOKEN_DB_PATH}`);
	try {
		await initializeTokenDatabase();
	} catch (error) {
		console.error("[TOKEN_DB] Error initializing token database:", error);
	}
})(); 