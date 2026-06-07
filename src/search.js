const BELCHARGE_API = "https://belcharge.by/api";
const query = process.argv.slice(2).join(" ").trim().toLowerCase();

if (!query) {
  console.error('Usage: npm run search -- "station name"');
  process.exit(1);
}

const response = await fetch(`${BELCHARGE_API}/map/locations`, {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: "{}"
});

if (!response.ok) {
  throw new Error(`BelCharge search failed: ${response.status} ${response.statusText}`);
}

const data = await response.json();
const locations = data.value || [];
const matches = locations
  .filter((location) => matchesQuery(location, query))
  .slice(0, 25);

for (const location of matches) {
  const availability = location.availableConnectorsExist ? "available" : "busy";
  console.log(`${location.id} | ${availability} | ${location.provider} | ${location.name}`);
  console.log(`  ${location.address || location.description || ""}`);
  console.log(`  connectors=${location.connectorsCount}, power=${location.minPower}-${location.maxPower} kW`);
}

if (matches.length === 0) {
  console.log("No stations found.");
}

function matchesQuery(location, normalizedQuery) {
  return [
    location.name,
    location.address,
    location.description,
    location.provider
  ].filter(Boolean).some((value) => String(value).toLowerCase().includes(normalizedQuery));
}
