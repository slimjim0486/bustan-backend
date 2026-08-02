export function bookingTransactionLockKeys(input: {
  restaurantId: string;
  customerId: string;
  gstDayStart: Date;
}): string[] {
  return [
    `booking-customer:${input.restaurantId}:${input.customerId}`,
    `booking-day:${input.restaurantId}:${input.gstDayStart.toISOString()}`,
  ].sort();
}
