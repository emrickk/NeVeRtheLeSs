import { getSearchPaletteJson } from '../utils/search-palette-data';

export async function GET() {
  const { json } = await getSearchPaletteJson();
  return new Response(json, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
