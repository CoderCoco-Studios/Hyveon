import { describe, expect, it } from 'vitest';
import { UploadReservations } from './uploadReservations.js';

const SAVES = { game: 'mc', volume: 'saves' };

// @spec HELPER-RSV-001
describe('UploadReservations', () => {
  it('should refuse a path that is already reserved and report which one', () => {
    const reservations = new UploadReservations();
    expect(reservations.tryReserve(SAVES, ['/a.txt']).ok).toBe(true);
    expect(reservations.tryReserve(SAVES, ['/b.txt', '/a.txt'])).toEqual({ ok: false, conflict: '/a.txt' });
  });

  it('should reserve all of a call\'s paths or none of them', () => {
    const reservations = new UploadReservations();
    reservations.tryReserve(SAVES, ['/b.txt']);
    expect(reservations.tryReserve(SAVES, ['/a.txt', '/b.txt']).ok).toBe(false);
    expect(reservations.tryReserve(SAVES, ['/a.txt']).ok).toBe(true);
  });

  it('should free the paths on release, and ignore a second release', () => {
    const reservations = new UploadReservations();
    const first = reservations.tryReserve(SAVES, ['/a.txt']);
    if (!first.ok) throw new Error('not reserved');
    first.release();
    const second = reservations.tryReserve(SAVES, ['/a.txt']);
    first.release();
    expect(second.ok).toBe(true);
    expect(reservations.tryReserve(SAVES, ['/a.txt']).ok).toBe(false);
  });

  it('should keep volumes and games apart', () => {
    const reservations = new UploadReservations();
    reservations.tryReserve(SAVES, ['/a.txt']);
    expect(reservations.tryReserve({ game: 'mc', volume: 'config' }, ['/a.txt']).ok).toBe(true);
    expect(reservations.tryReserve({ game: 'other', volume: 'saves' }, ['/a.txt']).ok).toBe(true);
  });
});
