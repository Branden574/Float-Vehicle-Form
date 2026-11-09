const field = document.getElementById('receipt');
const fragment = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(fragment)) {
  field.value = fragment;
  history.replaceState(null, '', location.pathname);
}
document.getElementById('status-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const output = document.getElementById('result');
  output.textContent = 'Checking…';
  try {
    const response = await fetch('/api/deletion-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt: field.value.trim() }),
      cache: 'no-store',
    });
    const body = await response.json();
    if (!response.ok) throw Error(body.error || 'Please try again.');
    output.textContent =
      body.status === 'complete'
        ? 'Deletion complete. Your associated app data and recoverable backups have been removed.'
        : body.status === 'removing_backups'
          ? 'Your profile and files have been removed. Recoverable backup cleanup is still processing.'
          : 'Your account is closed. Data removal is processing.';
  } catch (error) {
    output.textContent = error.message || 'Unable to check. Please try again.';
  }
});
