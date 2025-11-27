import { openDb, closeDb, run } from './db.js';
import { sendNonFatalSlackNotification } from './slack/notifications.js';

const LOCK_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

// Function to clean up expired booking locks
async function cleanupOldBookingLocks() {
    let db;
    const now_iso = new Date().toISOString();
    console.log("[Booking Lock Cleanup] Running cleanup for locks expired before:", now_iso);
    try {
        db = await openDb();
        const result = await run(db,
            `DELETE FROM active_bookings_lock WHERE expires_at < ?`,
            [now_iso]
        );
        if (result && result.changes > 0) {
            console.log(`[Booking Lock Cleanup] Removed ${result.changes} expired booking locks.`);
        } else {
            console.log("[Booking Lock Cleanup] No expired booking locks found.");
        }
    } catch (error) {
        console.error("[Booking Lock Cleanup] Error cleaning up old booking locks:", error);
        sendNonFatalSlackNotification(
            'Booking Lock Cleanup Error',
            'Error cleaning up old booking locks in bookingLock.js',
            { error: error.message, stack: error.stack }
        ).catch(console.error); // Log if sending notification fails
    } finally {
        await closeDb(db);
    }
}

// Function to start the periodic cleanup
export function startBookingLockCleanup(intervalMs = LOCK_CLEANUP_INTERVAL_MS) {
    console.log(`[Booking Lock Cleanup] Starting cleanup process. Interval: ${intervalMs / 1000} seconds.`);
    // Initial cleanup
    cleanupOldBookingLocks().catch(console.error);
    // Set interval for subsequent cleanups
    setInterval(() => {
        cleanupOldBookingLocks().catch(console.error);
    }, intervalMs);
} 