import { openDb, closeDb, run, get as getDbRecord } from './db.js';

// Helper functions to store, retrieve, and delete call data in SQLite
export async function getCallData(callSid) {
  let db;
  try {
    if (!callSid) {
      console.error('CallSid is required for getCallData');
      return null;
    }
    db = await openDb();
    const row = await getDbRecord(db, "SELECT *, strftime('%s', created_at) as created_at_unix FROM calls WHERE callSid = ?", [callSid]);
    if (row) {
      if (row.retry_count !== null && row.retry_count !== undefined) {
        row.retry_count = Number(row.retry_count);
      }
      if (row.first_attempt_timestamp) {
        row.first_attempt_timestamp = new Date(row.first_attempt_timestamp);
      }
      console.log(`[getCallData] Found record for callSid: ${callSid} - contactId: ${row.contactId}, phone: ${row.phone}, retry_count: ${row.retry_count}`);
    } else {
      console.log(`[getCallData] No record found for callSid: ${callSid} in calls table`);
      return null;
    }
    return row;
  } catch (error) {
    console.error(`Error getting call data for ${callSid} from SQLite:`, error);
    throw error;
  } finally {
    if (db) await closeDb(db);
  }
}

export async function setCallData(callSid, data) {
  let db;
  try {
    if (!callSid) {
      console.error('CallSid is required for setCallData');
      return;
    }
    if (!data || typeof data !== 'object') {
      console.error('Valid data object is required for setCallData');
      return;
    }

    db = await openDb();

    // Create a new object for insertion to avoid modifying the original `data` object
    const dataForDb = { ...data };

    // Always ensure primary key is present
    dataForDb.callSid = callSid;

    // Explicitly map `to` to `phone` if it exists
    if (dataForDb.hasOwnProperty('to')) {
        dataForDb.phone = dataForDb.to;
        delete dataForDb.to; // Remove the original 'to' to avoid confusion
    }

    const columns = [
      'callSid', 'phone', 'contactId', 'retry_count', 'status', 'created_at',
      'signedUrl', 'fullName', 'firstName', 'email', 'answeredBy',
      'conversationId', 'first_attempt_timestamp', 'retry_scheduled',
      'full_address'
    ];

    const fields = [];
    const values = [];
    const placeholders = [];

    for (const col of columns) {
      if (dataForDb.hasOwnProperty(col) && dataForDb[col] !== undefined) {
        fields.push(col);
        values.push(dataForDb[col]);
        placeholders.push('?');
      }
    }
    
    if (fields.length === 0) {
        console.error('No valid fields to insert/update for setCallData', callSid);
        return;
    }

    const sql = `INSERT OR REPLACE INTO calls (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`;
    await run(db, sql, values);

  } catch (error) {
    console.error(`Error setting call data for ${callSid} in SQLite:`, error);
    throw error;
  } finally {
    if (db) await closeDb(db);
  }
}

export async function updateCallData(callSid, dataToUpdate) {
  let db;
  try {
    if (!callSid || !dataToUpdate || typeof dataToUpdate !== 'object' || Object.keys(dataToUpdate).length === 0) {
      console.error('CallSid and valid dataToUpdate object are required for updateCallData');
      return;
    }
    
    const dataForUpdate = { ...dataToUpdate };

    // Map `to` to `phone` for updates as well
    if (dataForUpdate.hasOwnProperty('to')) {
        dataForUpdate.phone = dataForUpdate.to;
        delete dataForUpdate.to;
    }

    db = await openDb();
    const fields = [];
    const values = [];

    for (const key in dataForUpdate) {
      if (dataForUpdate.hasOwnProperty(key)) {
        fields.push(`${key} = ?`);
        values.push(dataForUpdate[key]);
      }
    }

    if (fields.length === 0) {
      console.error('No fields to update for callSid:', callSid);
      return;
    }

    values.push(callSid); // For the WHERE clause
    const sql = `UPDATE calls SET ${fields.join(', ')} WHERE callSid = ?`;
    await run(db, sql, values);
  } catch (error) {
    console.error(`Error updating call data for ${callSid} in SQLite:`, error);
    throw error;
  } finally {
    if (db) await closeDb(db);
  }
} 