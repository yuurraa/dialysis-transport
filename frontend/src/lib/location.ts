export interface DriverLocation {
  latitude: number;
  longitude: number;
  accuracyMetres: number;
  recordedAt: string;
}

/**
 * Call only after the assigned driver chooses to share during an active trip.
 * Run the returned cleanup on trip end, cancellation, sign-out or unmount.
 * Backend trip/role checks remain mandatory. This does not promise background tracking.
 */
export function watchDriverLocation(
  onLocation: (location: DriverLocation) => void,
  onError: (message: string) => void,
): () => void {
  if (!window.isSecureContext || !navigator.geolocation) {
    onError('Location sharing requires a supported browser and a secure connection.');
    return () => {};
  }

  let stopped = false;
  const watchId = navigator.geolocation.watchPosition(
    position => {
      if (stopped || document.visibilityState !== 'visible') return;
      onLocation({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMetres: position.coords.accuracy,
        recordedAt: new Date(position.timestamp).toISOString(),
      });
    },
    error => {
      if (!stopped) onError(error.code === 1 ? 'Location permission was denied.' : 'Your location is temporarily unavailable.');
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 },
  );

  return () => {
    stopped = true;
    navigator.geolocation.clearWatch(watchId);
  };
}
