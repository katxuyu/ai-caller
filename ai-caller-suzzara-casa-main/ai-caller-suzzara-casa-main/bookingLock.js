import { openDataDb, closeDataDb, runData } from './dataDb.js';
import { sendNonFatalSlackNotification } from './slack/notifications.js';

const LOCK_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

// Function to clean up expired booking locks
async function cleanupOldBookingLocks() {
    let db;
    const now_iso = new Date().toISOString();
    try {
        db = await openDataDb();
        const result = await runData(db,
            `DELETE FROM active_bookings_lock WHERE expires_at < ?`,
            [now_iso]
        );
        if (result && result.changes > 0) {
            console.log(`[Booking Lock Cleanup] Removed ${result.changes} expired booking locks.`);
        }
    } catch (error) {
        console.error("[Booking Lock Cleanup] Error cleaning up old booking locks:", error);
        sendNonFatalSlackNotification(
            'Booking Lock Cleanup Error',
            'Error cleaning up old booking locks in bookingLock.js',
            { error: error.message, stack: error.stack }
        ).catch(console.error); // Log if sending notification fails
    } finally {
        await closeDataDb(db);
    }
}

// Function to start the periodic cleanup
export function startBookingLockCleanup(intervalMs = LOCK_CLEANUP_INTERVAL_MS) {
    // Initial cleanup
    cleanupOldBookingLocks().catch(console.error);
    // Set interval for subsequent cleanups
    setInterval(() => {
        cleanupOldBookingLocks().catch(console.error);
    }, intervalMs);
} 