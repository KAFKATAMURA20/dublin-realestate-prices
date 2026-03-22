// Vercel Serverless Function - BER Lookup via Claude
// Deploy to: /api/lookup-ber

export const config = {
  runtime: 'edge',
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tuzyldwtwrnkwvvqafzx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // Use service key for writes

export default async function handler(request) {
  // Handle CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { address, eircode, property_id } = await request.json();

    if (!address) {
      return new Response(JSON.stringify({ error: 'Address required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check if we already have cached data
    if (property_id) {
      const cached = await checkCache(property_id);
      if (cached && (cached.ber_rating || cached.floor_area_sqm)) {
        return new Response(JSON.stringify({
          source: 'cache',
          data: cached
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }

    // Search for BER data using Claude
    const searchQuery = eircode
      ? `${eircode} BER rating myhome.ie`
      : `"${address}" BER rating myhome.ie`;

    const berData = await searchWithClaude(searchQuery, address, eircode);

    // Save to Supabase if we have property_id
    if (property_id && berData && (berData.ber_rating || berData.floor_area_sqm)) {
      await saveToSupabase(property_id, berData);
    }

    return new Response(JSON.stringify({
      source: 'search',
      data: berData
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (error) {
    console.error('BER lookup error:', error);
    return new Response(JSON.stringify({
      error: 'Lookup failed',
      message: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

async function searchWithClaude(query, address, eircode) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      tools: [{
        type: 'web_search',
        name: 'web_search',
      }],
      messages: [{
        role: 'user',
        content: `Search for BER (Building Energy Rating) data for this Irish property:
Address: ${address}
${eircode ? `Eircode: ${eircode}` : ''}

Search query to use: ${query}

Extract and return ONLY a JSON object with these fields (use null if not found):
{
  "ber_rating": "A1/A2/A3/B1/B2/B3/C1/C2/C3/D1/D2/E1/E2/F/G or null",
  "ber_number": "9-digit BER certificate number or null",
  "energy_kwh_m2_yr": number or null,
  "floor_area_sqm": number or null,
  "bedrooms": number or null,
  "bathrooms": number or null,
  "heating_type": "string or null",
  "source_url": "URL where data was found or null"
}

Return ONLY the JSON, no other text.`
      }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();

  // Extract the JSON from Claude's response
  const content = result.content.find(c => c.type === 'text');
  if (!content) {
    return null;
  }

  try {
    // Try to parse JSON from response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('Failed to parse Claude response:', content.text);
  }

  return null;
}

async function checkCache(propertyId) {
  if (!SUPABASE_KEY) return null;

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/property_details?property_id=eq.${propertyId}&select=*`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    }
  );

  if (!response.ok) return null;

  const data = await response.json();
  return data.length > 0 ? data[0] : null;
}

async function saveToSupabase(propertyId, berData) {
  if (!SUPABASE_KEY) return;

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/property_details`,
    {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        property_id: propertyId,
        ber_rating: berData.ber_rating,
        ber_number: berData.ber_number,
        energy_kwh_m2_yr: berData.energy_kwh_m2_yr,
        floor_area_sqm: berData.floor_area_sqm,
        bedrooms: berData.bedrooms,
        bathrooms: berData.bathrooms,
        heating_type: berData.heating_type,
        source_url: berData.source_url,
      }),
    }
  );

  if (!response.ok) {
    console.error('Failed to save to Supabase:', await response.text());
  }
}
