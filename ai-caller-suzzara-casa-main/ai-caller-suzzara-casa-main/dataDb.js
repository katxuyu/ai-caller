import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants for database paths
const DATA_DB_PATH = process.env.SQLITE_DATA_DB_PATH || path.join(__dirname, 'data.db');

let dataInitializationPromise = null;

// Function to open data DB connection
export function openDataDb() {
	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(DATA_DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
			if (err) {
				console.error('[DATA_DB] Error opening data database', err.message);
				reject(err);
			} else {
				resolve(db);
			}
		});
	});
}

// Function to close data DB connection
export function closeDataDb(db) {
	return new Promise((resolve, reject) => {
		if (db) {
			db.close((err) => {
				if (err) {
					console.error('[DATA_DB] Error closing data database', err.message);
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

// Promisify db operations for data database
export function runData(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function (err) {
			if (err) {
				console.error('[DATA_DB] Error running sql: ', sql);
				console.error('[DATA_DB] Params: ', params);
				console.error('[DATA_DB] Error: ', err);
				reject(err);
			} else {
				resolve({ lastID: this.lastID, changes: this.changes });
			}
		});
	});
}

export function getData(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.get(sql, params, (err, result) => {
			if (err) {
				console.error('[DATA_DB] Error running sql: ', sql);
				console.error('[DATA_DB] Params: ', params);
				console.error('[DATA_DB] Error: ', err);
				reject(err);
			} else {
				resolve(result);
			}
		});
	});
}

export function allData(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => {
			if (err) {
				console.error('[DATA_DB] Error running sql: ', sql);
				console.error('[DATA_DB] Params: ', params);
				console.error('[DATA_DB] Error: ', err);
				reject(err);
			} else {
				resolve(rows);
			}
		});
	});
}

// Initialize data database with all business data tables
export async function initializeDataDatabase() {
	if (dataInitializationPromise) {
		return dataInitializationPromise;
	}

	dataInitializationPromise = (async () => {
		let db;
		try {
			console.log("[DATA_DB] Initializing data database...");
			db = await openDataDb();

			const addColumnIfNotExists = async (tableName, columnName, columnDefinition) => {
				const rows = await allData(db, `PRAGMA table_info(${tableName})`);
				const columnExists = rows.some(column => column.name === columnName);
				if (!columnExists) {
					console.log(`[DATA_DB] Column '${columnName}' not found in '${tableName}'. Adding it...`);
					await runData(db, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
					console.log(`[DATA_DB] Column '${columnName}' added to '${tableName}' successfully.`);
				}
			};

			// Follow-ups table
			await runData(db, `CREATE TABLE IF NOT EXISTS follow_ups (
				follow_up_id INTEGER PRIMARY KEY AUTOINCREMENT,
				contact_id TEXT NOT NULL,
				follow_up_at_utc TEXT NOT NULL,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				status TEXT DEFAULT 'pending'
			)`);
			console.log("[DATA_DB] follow_ups table checked/created successfully.");

			// Calls table
			await runData(db, `CREATE TABLE IF NOT EXISTS calls (
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
				first_attempt_timestamp DATETIME
			)`);
			console.log("[DATA_DB] calls table checked/created successfully.");

			// Check and add missing columns to calls table
			await addColumnIfNotExists('calls', 'first_attempt_timestamp', 'DATETIME');
			await addColumnIfNotExists('calls', 'retry_scheduled', 'INTEGER DEFAULT 0');
			await addColumnIfNotExists('calls', 'transcript_summary', 'TEXT');
			await addColumnIfNotExists('calls', 'updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');

			// Incoming calls table
			await runData(db, `CREATE TABLE IF NOT EXISTS incoming_calls (
				callSid TEXT PRIMARY KEY NOT NULL,
				caller_number TEXT,
				callee_number TEXT,
				status TEXT,
				created_at TEXT,
				signedUrl TEXT,
				availableSlots TEXT,
				conversationId TEXT
			)`);
			console.log("[DATA_DB] incoming_calls table checked/created successfully.");

			// Check and add missing columns to incoming_calls table
			await addColumnIfNotExists('incoming_calls', 'twilioCallSid', 'TEXT');
			await addColumnIfNotExists('incoming_calls', 'ghl_contact_id', 'TEXT');
			await addColumnIfNotExists('incoming_calls', 'ghl_full_name', 'TEXT');
			await addColumnIfNotExists('incoming_calls', 'ghl_email', 'TEXT');
			await addColumnIfNotExists('incoming_calls', 'signedUrlTimestamp', 'TEXT');

			// Booking locks table
			await runData(db, `CREATE TABLE IF NOT EXISTS active_bookings_lock (
				lock_id TEXT PRIMARY KEY NOT NULL,
				contact_id TEXT NOT NULL,
				calendar_id TEXT NOT NULL,
				location_id TEXT NOT NULL,
				slot_utc_iso TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				expires_at DATETIME NOT NULL
			)`);
			console.log("[DATA_DB] active_bookings_lock table checked/created successfully.");

			// Sales representatives table
			await runData(db, `CREATE TABLE IF NOT EXISTS sales_reps (
				rep_id INTEGER PRIMARY KEY AUTOINCREMENT,
				ghl_user_id TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				services TEXT NOT NULL,
				provinces TEXT NOT NULL,
				active BOOLEAN DEFAULT 1,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
			)`);
			console.log("[DATA_DB] sales_reps table checked/created successfully.");

			// Call queue table
			await runData(db, `CREATE TABLE IF NOT EXISTS call_queue (
				queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
				contact_id TEXT NOT NULL,
				phone_number TEXT NOT NULL,
				first_name TEXT,
				full_name TEXT,
				email TEXT,
				retry_stage INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'pending',
				scheduled_at DATETIME NOT NULL,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				first_attempt_timestamp DATETIME,
				last_attempt_at DATETIME,
				last_error TEXT,
				call_options_json TEXT,
				available_slots_text TEXT,
				initial_signed_url TEXT
			)`);
			console.log("[DATA_DB] call_queue table checked/created successfully.");

			// Migration: Remove service column from call_queue if it exists
			const callQueueTableInfoRows = await allData(db, "PRAGMA table_info(call_queue)");
			const hasServiceColumn = callQueueTableInfoRows.some(column => column && column.name === 'service');
			
			if (hasServiceColumn) {
				console.log("[DATA_DB] Found 'service' column in call_queue. Migrating to remove it...");
				
				// Create new table without service column
				await runData(db, `CREATE TABLE IF NOT EXISTS call_queue_new (
					queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
					contact_id TEXT NOT NULL,
					phone_number TEXT NOT NULL,
					first_name TEXT,
					full_name TEXT,
					email TEXT,
					retry_stage INTEGER NOT NULL DEFAULT 0,
					status TEXT NOT NULL DEFAULT 'pending',
					scheduled_at DATETIME NOT NULL,
					created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
					first_attempt_timestamp DATETIME,
					last_attempt_at DATETIME,
					last_error TEXT,
					call_options_json TEXT,
					available_slots_text TEXT,
					initial_signed_url TEXT
				)`);
				
				// Copy data from old table to new table (excluding service column)
				await runData(db, `INSERT INTO call_queue_new 
					(queue_id, contact_id, phone_number, first_name, full_name, email, retry_stage, status, scheduled_at, created_at, first_attempt_timestamp, last_attempt_at, last_error, call_options_json, available_slots_text, initial_signed_url)
					SELECT queue_id, contact_id, phone_number, first_name, full_name, email, retry_stage, status, scheduled_at, created_at, first_attempt_timestamp, last_attempt_at, last_error, call_options_json, available_slots_text, initial_signed_url
					FROM call_queue`);
				
				// Drop old table and rename new table
				await runData(db, `DROP TABLE call_queue`);
				await runData(db, `ALTER TABLE call_queue_new RENAME TO call_queue`);
				
				console.log("[DATA_DB] Successfully migrated call_queue table to remove service column.");
			}

		} catch (error) {
			console.error("[DATA_DB] Error initializing data database:", error);
			dataInitializationPromise = null; // Reset on error to allow retrying
			throw error; // Let the caller handle the error
		} finally {
			if (db) await closeDataDb(db);
		}
	})();

	return dataInitializationPromise;
}

// Helper functions for sales representatives
export async function getSalesRepsByServiceAndProvince(service, province) {
	let db;
	try {
		db = await openDataDb();
		const reps = await allData(db, 
			`SELECT ghl_user_id, name, services, provinces 
			 FROM sales_reps 
			 WHERE active = 1`,
			[]
		);
		
		// Filter reps that handle the specified service and province
		const matchingReps = reps.filter(rep => {
			try {
				const repServices = JSON.parse(rep.services);
				const repProvinces = JSON.parse(rep.provinces);
				
				return repServices.includes(service) && repProvinces.includes(province);
			} catch (parseError) {
				console.error(`[DATA_DB] Error parsing JSON for rep ${rep.ghl_user_id}:`, parseError);
				return false;
			}
		});
		
		return matchingReps.map(rep => ({
			ghlUserId: rep.ghl_user_id,
			name: rep.name,
			services: JSON.parse(rep.services),
			provinces: JSON.parse(rep.provinces)
		}));
	} catch (error) {
		console.error('[DATA_DB] Error fetching sales reps by service and province:', error);
		return [];
	} finally {
		if (db) await closeDataDb(db);
	}
}

export async function addSalesRep(ghlUserId, name, services, provinces) {
	let db;
	try {
		db = await openDataDb();
		const result = await runData(db,
			`INSERT INTO sales_reps (ghl_user_id, name, services, provinces)
			 VALUES (?, ?, ?, ?)`,
			[ghlUserId, name, JSON.stringify(services), JSON.stringify(provinces)]
		);
		console.log(`[DATA_DB] Added sales rep ${name} with ID: ${result.lastID}`);
		return result.lastID;
	} catch (error) {
		console.error('[DATA_DB] Error adding sales rep:', error);
		throw error;
	} finally {
		if (db) await closeDataDb(db);
	}
}

export async function getAllSalesReps() {
	let db;
	try {
		db = await openDataDb();
		const reps = await allData(db, 
			`SELECT rep_id, ghl_user_id, name, services, provinces, active, created_at 
			 FROM sales_reps 
			 ORDER BY name`,
			[]
		);
		
		return reps.map(rep => ({
			repId: rep.rep_id,
			ghlUserId: rep.ghl_user_id,
			name: rep.name,
			services: JSON.parse(rep.services),
			provinces: JSON.parse(rep.provinces),
			active: Boolean(rep.active),
			createdAt: rep.created_at
		}));
	} catch (error) {
		console.error('[DATA_DB] Error fetching all sales reps:', error);
		return [];
	} finally {
		if (db) await closeDataDb(db);
	}
}

export async function updateSalesRepStatus(ghlUserId, active) {
	let db;
	try {
		db = await openDataDb();
		const result = await runData(db,
			`UPDATE sales_reps SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE ghl_user_id = ?`,
			[active ? 1 : 0, ghlUserId]
		);
		console.log(`[DATA_DB] Updated sales rep ${ghlUserId} status to ${active ? 'active' : 'inactive'}`);
		return result.changes > 0;
	} catch (error) {
		console.error('[DATA_DB] Error updating sales rep status:', error);
		throw error;
	} finally {
		if (db) await closeDataDb(db);
	}
}

export async function clearAllSalesReps() {
	let db;
	try {
		db = await openDataDb();
		const result = await runData(db, `DELETE FROM sales_reps`, []);
		console.log(`[DATA_DB] Cleared ${result.changes} sales representatives from database`);
		return result.changes;
	} catch (error) {
		console.error('[DATA_DB] Error clearing sales reps:', error);
		throw error;
	} finally {
		if (db) await closeDataDb(db);
	}
}

// Initialize data database on module load
(async () => {
	console.log(`Data database path: ${DATA_DB_PATH}`);
	try {
		await initializeDataDatabase();
	} catch (error) {
		console.error("[DATA_DB] Error initializing data database:", error);
	}
})(); 