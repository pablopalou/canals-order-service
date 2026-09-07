import { AppError } from '../errors.ts';

export type Coordinates = { latitude: number; longitude: number };

export type Address = {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

export interface GeocodingProvider {
  geocode(address: Address): Promise<Coordinates>;
}

/**
 * Stand-in for a third-party geocoding API (Google, Mapbox, Smarty).
 *
 * It is deliberately deterministic rather than random: the warehouse chosen
 * for a given address must be reproducible, otherwise neither the README
 * examples nor the tests mean anything. Known US metros resolve to their real
 * coordinates; anything else is hashed into a point inside the continental US
 * so unknown addresses still behave sensibly instead of failing.
 */
const KNOWN_CITIES: Record<string, Coordinates> = {
  'philadelphia,pa': { latitude: 39.9526, longitude: -75.1652 },
  'new york,ny': { latitude: 40.7128, longitude: -74.006 },
  'newark,nj': { latitude: 40.7357, longitude: -74.1724 },
  'boston,ma': { latitude: 42.3601, longitude: -71.0589 },
  'atlanta,ga': { latitude: 33.749, longitude: -84.388 },
  'miami,fl': { latitude: 25.7617, longitude: -80.1918 },
  'charlotte,nc': { latitude: 35.2271, longitude: -80.8431 },
  'chicago,il': { latitude: 41.8781, longitude: -87.6298 },
  'detroit,mi': { latitude: 42.3314, longitude: -83.0458 },
  'dallas,tx': { latitude: 32.7767, longitude: -96.797 },
  'houston,tx': { latitude: 29.7604, longitude: -95.3698 },
  'denver,co': { latitude: 39.7392, longitude: -104.9903 },
  'phoenix,az': { latitude: 33.4484, longitude: -112.074 },
  'los angeles,ca': { latitude: 34.0522, longitude: -118.2437 },
  'san francisco,ca': { latitude: 37.7749, longitude: -122.4194 },
  'seattle,wa': { latitude: 47.6062, longitude: -122.3321 },
};

/** FNV-1a: small, dependency-free, and stable across processes. */
const hash = (value: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

const normalize = (address: Address) =>
  `${address.city.trim().toLowerCase()},${address.state.trim().toLowerCase()}`;

export class MockGeocodingProvider implements GeocodingProvider {
  constructor(private readonly latencyMs = 0) {}

  async geocode(address: Address): Promise<Coordinates> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    if (address.country.trim().toUpperCase() !== 'US') {
      throw new AppError(
        422,
        'address_not_geocodable',
        `Only US addresses are supported, received country "${address.country}"`,
      );
    }

    const known = KNOWN_CITIES[normalize(address)];
    if (known) return known;

    // Deterministic fallback inside the continental US bounding box.
    const seed = hash(`${normalize(address)}|${address.postalCode.trim()}`);
    return {
      latitude: 25 + ((seed >>> 8) % 2400) / 100, // 25.00 .. 48.99
      longitude: -125 + (seed % 5800) / 100, // -125.00 .. -67.01
    };
  }
}
