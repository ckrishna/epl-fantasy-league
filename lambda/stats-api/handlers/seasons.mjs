import { getAllSeasons } from '../utils/dynamodb.mjs';

// Powers the season dropdown: lists every season on record, not just the current one,
// so the frontend has something to populate its selector from.
export async function handleSeasons(corsHeaders) {
  const seasons = await getAllSeasons();

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      seasons: seasons.map(s => ({
        season: s.season_string,
        current: !!s.current,
        status: s.status ?? null,
        start_date: s.start_date ?? null,
        end_date: s.end_date ?? null,
        total_gameweeks: s.total_gameweeks ?? null
      }))
    })
  };
}
