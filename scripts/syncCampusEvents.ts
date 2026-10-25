import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey)

const CAMPUS_LABS_API =
  "https://bc.campuslabs.com/engage/api/discovery/event/search";

// How many events to request per page.
const PAGE_SIZE = 100;

// Safety limit so a bug can never cause an endless loop (50 x 100 = 5000 events).
const MAX_PAGES = 50;

// Capture "now" once so every page uses the same filter.
const now = new Date().toISOString();

function buildPageUrl(skip: number) {
  const params = new URLSearchParams({
    endsAfter: now,
    orderByField: "endsOn",
    orderByDirection: "ascending",
    status: "Approved",
    take: String(PAGE_SIZE),
    skip: String(skip),
    query: "",
  });

  return `${CAMPUS_LABS_API}?${params.toString()}`;
}

// Fetch every page until we have all events reported by @odata.count.
async function fetchAllEvents() {
  const allEvents: any[] = [];
  let totalCount: number | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const skip = page * PAGE_SIZE;
    const response = await fetch(buildPageUrl(skip));

    if (!response.ok) {
      throw new Error(
        `Campus Labs request failed (skip=${skip}): HTTP ${response.status}`
      );
    }

    const data = await response.json();

    if (totalCount === null) {
      totalCount = Number(data["@odata.count"]);
    }

    const pageEvents = data.value ?? [];
    allEvents.push(...pageEvents);

    console.log(
      `Page ${page + 1}: got ${pageEvents.length} events (total so far: ${allEvents.length} / ${totalCount})`
    );

    const isLastPage = pageEvents.length < PAGE_SIZE;
    const haveEverything = allEvents.length >= totalCount;

    if (isLastPage || haveEverything) {
      break;
    }
  }

  return { events: allEvents, totalCount };
}

// Keep one copy of each event. Paging over a non-unique sort (many events
// share the same endsOn) can return the same event on two pages.
function dedupeById(events: any[]) {
  const eventsById = new Map<string, any>();

  for (const event of events) {
    eventsById.set(String(event.id), event);
  }

  return [...eventsById.values()];
}

const LOCATION_COORDS: Record<string, [number, number]> = {
        // O'Neill Library / O'Neill Plaza area
        "O'Neill Plaza": [42.33535, -71.16945],
        "O'Neill Library": [42.33535, -71.16945],
      
        // McElroy Commons area
        // Heights Room / Cabaret Room are BC event/dining spaces associated with McElroy/New Dining Hall area.
        "McElroy Commons": [42.33715, -71.17100],
        "Heights Room": [42.33715, -71.17100],
        "Cabaret Room": [42.33715, -71.17100],
      
        // Corcoran Commons / Lower Dining Hall area
        "Corcoran Commons": [42.33420, -71.16695],
        "Lower Dining Hall": [42.33420, -71.16695],
        "Upstairs at Lower Dining Hall": [42.33420, -71.16695],
      
        // O'Connell House
        "O'Connell House": [42.34135, -71.16595],
      
        // Linden Lane / Gasson Quad area
        "Linden Lane": [42.33565, -71.16865],
        "Gasson Hall": [42.33575, -71.16855],
        "Gasson Quad": [42.33545, -71.16880],
      
        // Stokes area
        "Stokes Hall": [42.33445, -71.17085],
      
        // Between Vandy and Lower = near Vanderslice / Corcoran Commons walkway
        "Between Vandy and Lower": [42.33500, -71.16725],
      };
// Campus Labs sends coordinates as strings (e.g. "42.339520") or null.
// Returns a number, or null if the value is missing or not a valid coordinate.
function parseCoordinate(value: unknown, limit: number): number | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || Math.abs(number) > limit) {
    return null;
  }

  return number;
}

// Center of BC's main campus (same as the map's default center in MapPage.tsx).
const BC_CAMPUS_CENTER: [number, number] = [42.3355, -71.1685];

// Coordinates farther than this from campus are treated as data errors
// (e.g. swapped latitude/longitude). 50 km still covers the Boston area.
const MAX_DISTANCE_FROM_CAMPUS_KM = 50;

// Great-circle distance between two points, in kilometers (haversine formula).
function distanceKm([lat1, lng1]: [number, number], [lat2, lng2]: [number, number]) {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;

  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type CoordinateResult = {
  latitude: number | null;
  longitude: number | null;
  // Set when Campus Labs sent coordinates that we rejected as too far away.
  rejectedKm: number | null;
};

// Prefer the coordinates Campus Labs provides. Fall back to the hand-written
// LOCATION_COORDS table only when Campus Labs has no usable coordinates.
function getCoordinates(event: any): CoordinateResult {
  const latitude = parseCoordinate(event.latitude, 90);
  const longitude = parseCoordinate(event.longitude, 180);
  let rejectedKm: number | null = null;

  if (latitude !== null && longitude !== null) {
    const km = distanceKm([latitude, longitude], BC_CAMPUS_CENTER);

    if (km <= MAX_DISTANCE_FROM_CAMPUS_KM) {
      return { latitude, longitude, rejectedKm: null };
    }

    rejectedKm = Math.round(km);
  }

  const fallback = LOCATION_COORDS[event.location];

  return fallback
    ? { latitude: fallback[0], longitude: fallback[1], rejectedKm }
    : { latitude: null, longitude: null, rejectedKm };
}

async function syncEvents() {
  try {
    const { events: fetchedEvents, totalCount } = await fetchAllEvents()
    const events = dedupeById(fetchedEvents)
    const duplicateCount = fetchedEvents.length - events.length

    console.log(
      `Fetched ${fetchedEvents.length} events, ${duplicateCount} duplicates removed, ${events.length} unique (API reports ${totalCount})`
    )

    // Stop before writing anything if we did not get exactly what the API reported.
    if (events.length !== totalCount) {
      throw new Error(
        `Count check failed: got ${events.length} unique events but the API reports ${totalCount}. Nothing was written to the database.`
      )
    }

    const rejectedCoordinates: string[] = []

    const formattedEvents = events.map((event: any) => {
      const { latitude, longitude, rejectedKm } = getCoordinates(event)

      if (rejectedKm !== null) {
        rejectedCoordinates.push(
          `  event ${event.id} "${event.location}": (${event.latitude}, ${event.longitude}) is ${rejectedKm} km from campus`
        )
      }

      return {
        campus_labs_id: event.id,
        institution_id: event.institutionId,
        organization_id: event.organizationId,
        branch_id: event.branchId,
        organization_name: event.organizationName,
        organization_profile_picture:
          event.organizationProfilePicture,
        title: event.name,
        description: event.description,
        location: event.location,
        start_time: event.startsOn,
        end_time: event.endsOn,
        image_path: event.imagePath,
        theme: event.theme,
        visibility: event.visibility,
        approval_status: event.status,
        latitude,
        longitude,
        rec_score: event.recScore,
        rsvp_total: event.rsvpTotal,
        search_score: event['@search.score'],
      }
    })

    const mappedCount = formattedEvents.filter(
      (event) => event.latitude !== null && event.longitude !== null
    ).length

    console.log(`Events with map coordinates: ${mappedCount} / ${formattedEvents.length}`)

    if (rejectedCoordinates.length > 0) {
      console.warn(
        `Rejected ${rejectedCoordinates.length} coordinates more than ${MAX_DISTANCE_FROM_CAMPUS_KM} km from campus:\n${rejectedCoordinates.join('\n')}`
      )
    }

    const { error } = await supabase
      .from('events')
      .upsert(formattedEvents, {
        onConflict: 'campus_labs_id',
      })

    if (error) {
      console.error('Supabase insert error:', error)
      process.exitCode = 1
    } else {
      console.log(`Events synced successfully! (${formattedEvents.length} events)`)
    }
  } catch (err) {
    console.error(err)
    // Non-zero exit code so a scheduled job can detect the failure.
    process.exitCode = 1
  }
}

syncEvents()