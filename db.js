import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, 'database.db'); // Use env var or default

// Function to open DB connection
export function openDb() {
	return new Promise((resolve, reject) => {
		// Use verbose mode for more detailed errors during development
		const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
			if (err) {
				console.error('[DB] Error opening database', err.message);
				reject(err);
			} else {
				// console.log('[DB] Database connected.'); // Optional: log connection
				resolve(db);
			}
		});
	});
}

// Function to close DB connection
export function closeDb(db) {
	return new Promise((resolve, reject) => {
		if (db) {
			db.close((err) => {
				if (err) {
					console.error('[DB] Error closing database', err.message);
					reject(err);
				} else {
					// console.log('[DB] Database connection closed.'); // Optional: log close
					resolve();
				}
			});
		} else {
			resolve(); // No db instance to close
		}
	});
}

// Promisify db.run, db.get, db.all
export function run(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function (err) { // Use function() to access this.lastID, this.changes
			if (err) {
				console.error('[DB] Error running sql: ', sql);
				console.error('[DB] Params: ', params);
				console.error('[DB] Error: ', err);
				reject(err);
			} else {
				resolve({ lastID: this.lastID, changes: this.changes });
			}
		});
	});
}

export function get(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.get(sql, params, (err, result) => {
			if (err) {
				console.error('[DB] Error running sql: ', sql);
				console.error('[DB] Params: ', params);
				console.error('[DB] Error: ', err);
				reject(err);
			} else {
				resolve(result); // result will be undefined if no row is found
			}
		});
	});
}

export function all(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => {
			if (err) {
				console.error('[DB] Error running sql: ', sql);
				console.error('[DB] Params: ', params);
				console.error('[DB] Error: ', err);
				reject(err);
			} else {
				resolve(rows);
			}
		});
	});
}

// Ensure the table exists
export async function initializeDatabase() {
	let db;
	try {
		console.log("[DB] Initializing database...");
		db = await openDb();
        
        // Helpers
        const columnExists = async (tableName, columnName) => {
            try {
                const columns = await all(db, `PRAGMA table_info(${tableName})`);
                return Array.isArray(columns) && columns.some((c) => c && c.name === columnName);
            } catch (e) {
                console.warn(`[DB] Failed to inspect table schema for ${tableName}:`, e.message);
                return false;
            }
        };
        const addColumnIfMissing = async (tableName, columnName, columnDefinition) => {
            const exists = await columnExists(tableName, columnName);
            if (!exists) {
                await run(db, `ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
                console.log(`[DB] Added ${columnName} column to ${tableName} table.`);
            }
        };
		// Use location_id as the primary key to ensure uniqueness per location
		await run(db, `CREATE TABLE IF NOT EXISTS gohighlevel_tokens (
			location_id TEXT PRIMARY KEY NOT NULL,
			access_token TEXT NOT NULL,
			refresh_token TEXT NOT NULL,
			expires_at TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`);
		console.log("[DB] gohighlevel_tokens table checked/created successfully (location_id as PRIMARY KEY).");

		// New table for follow-ups
		await run(db, `CREATE TABLE IF NOT EXISTS follow_ups (
			follow_up_id INTEGER PRIMARY KEY AUTOINCREMENT,
			contact_id TEXT NOT NULL,
			follow_up_at_utc TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			status TEXT DEFAULT 'pending'
		)`);
		console.log("[DB] follow_ups table checked/created successfully.");

        // New table for calls (replacing Firebase)
		await run(db, `CREATE TABLE IF NOT EXISTS calls (
			callSid TEXT PRIMARY KEY NOT NULL,
			phone TEXT,
			contactId TEXT,
			retry_count INTEGER DEFAULT 0,
			status TEXT,
			created_at TEXT,
			signedUrl TEXT,
			fullName TEXT,
			firstName TEXT,
			email TEXT,
			answeredBy TEXT,
			conversationId TEXT,
			full_address TEXT,
			transcript_summary TEXT,
			updated_at DATETIME,
			first_attempt_timestamp DATETIME,
			retry_scheduled INTEGER DEFAULT 0
		)`);
		console.log("[DB] calls table checked/created successfully.");
        // Backfill columns for existing databases
		await addColumnIfMissing('calls', 'retry_scheduled', 'retry_scheduled INTEGER DEFAULT 0');
		await addColumnIfMissing('calls', 'full_address', 'full_address TEXT');
		await addColumnIfMissing('calls', 'transcript_summary', 'transcript_summary TEXT');
		await addColumnIfMissing('calls', 'updated_at', 'updated_at DATETIME');

        // New table for the persistent call queue
		await run(db, `CREATE TABLE IF NOT EXISTS call_queue (
			queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
			contact_id TEXT NOT NULL,
			phone_number TEXT NOT NULL,
			first_name TEXT,
			full_name TEXT,
			email TEXT,
			full_address TEXT,
			retry_stage INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, failed, completed
			scheduled_at DATETIME NOT NULL, -- When the call should be attempted
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			first_attempt_timestamp DATETIME, -- Timestamp of the very first call attempt in a retry sequence
			last_attempt_at DATETIME,
			last_error TEXT,
			call_options_json TEXT, -- Store Twilio options like URL, timeout etc.
			initial_signed_url TEXT -- Store the URL generated when enqueuing
		)`);
		console.log("[DB] call_queue table checked/created successfully.");

        // Backfill for existing databases
        await addColumnIfMissing('call_queue', 'full_address', 'full_address TEXT');

	} catch (error) {
		console.error("[DB] Error initializing database table:", error);
		// Decide if the application should exit if DB init fails
		// process.exit(1);
	} finally {
		await closeDb(db);
	}
}

// Immediately-invoked function expression (IIFE) to set up the database
// and potentially log the path upon initial module load.
(async () => {
	console.log(`Database path: ${DB_PATH}`);
	try {
		await initializeDatabase(); // Ensure tables are created on startup
	} catch (error) {
		console.error("[DB] Error initializing database:", error);
	}
})();