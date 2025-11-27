import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendNonFatalSlackNotification } from './slack/notifications.js';

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
			"to" TEXT,
			contactId TEXT,
			retry_count INTEGER DEFAULT 0,
			status TEXT,
			created_at TEXT,
			signedUrl TEXT,
			fullName TEXT,
			firstName TEXT,
			email TEXT,
			answeredBy TEXT,
			availableSlots TEXT,
			conversationId TEXT,
			first_attempt_timestamp DATETIME,
			retry_scheduled BOOLEAN DEFAULT 0
		)`);
		console.log("[DB] calls table checked/created successfully.");

		// Check and add first_attempt_timestamp to calls if it doesn't exist
		const callsTableInfoRows = await all(db, "PRAGMA table_info(calls)");
		let foundFirstAttemptTimestampInCalls = false;
		if (callsTableInfoRows && callsTableInfoRows.length > 0) {
			foundFirstAttemptTimestampInCalls = callsTableInfoRows.some(column => column && column.name === 'first_attempt_timestamp');
		}

		if (!foundFirstAttemptTimestampInCalls) {
			console.log("[DB] Column 'first_attempt_timestamp' not found in 'calls'. Adding it...");
			await run(db, "ALTER TABLE calls ADD COLUMN first_attempt_timestamp DATETIME");
			console.log("[DB] Column 'first_attempt_timestamp' added to 'calls' successfully.");
		} else {
			console.log("[DB] Column 'first_attempt_timestamp' already exists in 'calls'.");
		}

		// Check and add retry_scheduled to calls if it doesn't exist
		const callsTableInfoForRetryScheduled = await all(db, "PRAGMA table_info(calls)");
		if (callsTableInfoForRetryScheduled && !callsTableInfoForRetryScheduled.some(c => c.name === 'retry_scheduled')) {
			console.log("[DB] Column 'retry_scheduled' not found in 'calls'. Adding it...");
			await run(db, "ALTER TABLE calls ADD COLUMN retry_scheduled BOOLEAN DEFAULT 0");
			console.log("[DB] Column 'retry_scheduled' added to 'calls' successfully.");
		} else {
			console.log("[DB] Column 'retry_scheduled' already exists in 'calls'.");
		}

		// New table for incoming calls
		await run(db, `CREATE TABLE IF NOT EXISTS incoming_calls (
			callSid TEXT PRIMARY KEY NOT NULL,
			caller_number TEXT,
			callee_number TEXT,
			status TEXT,
			created_at TEXT,
			signedUrl TEXT,
			availableSlots TEXT,
			conversationId TEXT
		)`);
		console.log("[DB] incoming_calls table checked/created successfully (before twilioCallSid check).");

		// Check and add twilioCallSid to incoming_calls if it doesn't exist
		const incomingCallsTableInfoRows = await all(db, "PRAGMA table_info(incoming_calls)"); // Changed get to all
		// PRAGMA table_info returns an object if only one row matches, or an array if multiple.
		// Ensure we handle both cases when checking for the column.
		let foundTwilioCallSid = false;
		if (incomingCallsTableInfoRows && incomingCallsTableInfoRows.length > 0) { // Check rows from all
			foundTwilioCallSid = incomingCallsTableInfoRows.some(column => column && column.name === 'twilioCallSid');
		}

		if (!foundTwilioCallSid) {
			console.log("[DB] Column 'twilioCallSid' not found in 'incoming_calls'. Adding it...");
			await run(db, "ALTER TABLE incoming_calls ADD COLUMN twilioCallSid TEXT");
			console.log("[DB] Column 'twilioCallSid' added to 'incoming_calls' successfully.");
		} else {
			console.log("[DB] Column 'twilioCallSid' already exists in 'incoming_calls'.");
		}

		// New table for the persistent call queue
		await run(db, `CREATE TABLE IF NOT EXISTS call_queue (
			queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
			contact_id TEXT NOT NULL,
			phone_number TEXT NOT NULL,
			first_name TEXT,
			full_name TEXT,
			email TEXT,
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

	} catch (error) {
		console.error("[DB] Error initializing database table:", error);
		await sendNonFatalSlackNotification(
			'Database: Initialization Failed',
			'Critical error during database initialization. Application functionality may be severely impacted.',
			{
				error: error.message,
				stack: error.stack,
				dbPath: DB_PATH,
				critical: true
			}
		).catch(console.error);
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
		await sendNonFatalSlackNotification(
			'Database: Startup Initialization Failed',
			'Failed to initialize database on application startup. Critical system failure.',
			{
				error: error.message,
				stack: error.stack,
				dbPath: DB_PATH,
				critical: true
			}
		).catch(console.error);
	}
})();