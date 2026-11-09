export function mayReviewReturns(user, settings) {
  if (!user?.active) return false;
  const emails = settings.returnReviewerEmails || [];
  return emails.length ? emails.includes(user.email.trim().toLowerCase()) : user.role === 'admin';
}
