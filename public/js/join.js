const usernameInput = document.getElementById('usernameInput');
const joinBtn = document.getElementById('joinBtn');
const errorEl = document.getElementById('error');

const stored = sessionStorage.getItem('wt_username');
if (stored) usernameInput.value = stored;

function showError(msg) {
  errorEl.textContent = msg || '';
  errorEl.style.display = msg ? 'block' : 'none';
}

// If the watch page could not join (e.g. duplicate username), it sends us back
// here with the reason so the user can pick another name.
const joinError = sessionStorage.getItem('wt_join_error');
if (joinError) {
  sessionStorage.removeItem('wt_join_error');
  showError(joinError);
}

// The actual join happens on the watch page. Joining here would create a
// second socket that disconnects on navigation, producing bogus left/joined
// system messages for everyone else.
joinBtn.addEventListener('click', () => {
  const username = usernameInput.value.trim();
  if (!username) return showError('Please enter a username');
  if (username.length < 2 || username.length > 32)
    return showError('Username must be between 2 and 32 characters');
  if (!/^[a-zA-Z0-9 _.\-]+$/.test(username))
    return showError('Username contains invalid characters (letters, numbers, space, _ . - only)');
  showError('');
  sessionStorage.setItem('wt_username', username);
  location.href = '/watch';
});

usernameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') joinBtn.click(); });
