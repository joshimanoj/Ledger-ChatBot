export function loadDB() {
  try {
    const raw = localStorage.getItem('ledgerDB_v3');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveDB(db) {
  localStorage.setItem('ledgerDB_v3', JSON.stringify(db));
}