const crypto = require('crypto');

// Random 12-character temporary password with upper, lower, digit and symbol; no look-alike characters.
function tempPassword() {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const L = 'abcdefghjkmnpqrstuvwxyz';
  const D = '23456789';
  const S = '@#$%';
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(U), pick(L), pick(D), pick(S)];
  while (chars.length < 12) chars.push(pick(U + L + D));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// Returns an error message, or null when the new password is acceptable.
function checkNewPassword(newPassword, currentPassword, username) {
  if (typeof newPassword !== 'string') return 'New password is required';
  if (
    newPassword.length < 8 ||
    Buffer.byteLength(newPassword) > 72 ||
    !/[A-Za-z]/.test(newPassword) ||
    !/\d/.test(newPassword)
  ) {
    return 'New password must be 8-72 characters and include at least one letter and one number';
  }
  if (newPassword === currentPassword) return 'New password must be different from the current password';
  if (username && newPassword.toLowerCase() === String(username).toLowerCase()) {
    return 'New password must not be the same as the username';
  }
  return null;
}

module.exports = { tempPassword, checkNewPassword };