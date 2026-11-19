(() => {
  const token = window.location.hash.slice(1);
  const request = document.querySelector('#request');
  const form = document.querySelector('#verify');
  const code = document.querySelector('#code');
  const status = document.querySelector('#status');
  if (!/^[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(token)) {
    request.disabled = true;
    status.textContent = 'Open the full private link from your Fleet Checkout email.';
    return;
  }
  async function post(path, data) {
    const response = await fetch('/api/report-copy/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...data }),
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || 'The request failed. Please try again.');
    }
    return response;
  }
  request.addEventListener('click', async () => {
    request.disabled = true;
    try {
      await post('request-code', {});
      status.textContent = 'Check your email for the newest report code.';
      form.hidden = false;
      code.value = '';
      code.focus();
      request.textContent = 'Send another code';
      setTimeout(() => {
        request.disabled = false;
      }, 60000);
    } catch (error) {
      status.textContent = error.message;
      request.disabled = false;
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelector('button').disabled = true;
    try {
      const response = await post('download', { code: code.value });
      if (response.headers.get('content-type').includes('application/json')) {
        window.location.assign((await response.json()).url);
      } else {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(await response.blob());
        link.download =
          response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ||
          'Fleet-Checkout.pdf';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      }
      form.hidden = true;
      status.textContent = 'Your report download has started.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      form.querySelector('button').disabled = false;
    }
  });
})();
