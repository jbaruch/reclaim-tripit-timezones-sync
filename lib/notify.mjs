import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

/**
 * Send a notification via AWS SNS if configured.
 * Requires SNS_TOPIC_ARN environment variable. If not set, notification is skipped.
 * AWS region is inferred from the topic ARN or AWS_REGION env var.
 *
 * @param {string} subject - Email subject line
 * @param {string} message - Email body
 */
export async function sendNotification(subject, message) {
  const topicArn = process.env.SNS_TOPIC_ARN;
  if (!topicArn) return;

  // Extract region from ARN: arn:aws:sns:REGION:ACCOUNT:TOPIC
  const arnRegion = topicArn.split(':')[3];
  const region = arnRegion || process.env.AWS_REGION || 'us-east-1';

  const client = new SNSClient({ region });
  await client.send(new PublishCommand({
    TopicArn: topicArn,
    Subject: subject,
    Message: message,
  }));

  console.log('  Notification sent via SNS');
}

/**
 * Build a summary message describing what changed.
 *
 * @param {Array} previousEntries - entries before sync
 * @param {Array} newSegments - segments that were created
 * @param {string} defaultTimezone - the user's default Reclaim timezone
 * @returns {{ subject: string, message: string }}
 */
export function buildSyncSummary(previousEntries, newSegments, defaultTimezone) {
  const prevCount = previousEntries.length;
  const newCount = newSegments.length;

  let subject;
  if (newCount === 0 && prevCount === 0) {
    subject = 'Reclaim Timezone Sync: No changes';
  } else if (newCount === 0) {
    subject = `Reclaim Timezone Sync: Cleared ${prevCount} entry/entries`;
  } else {
    subject = `Reclaim Timezone Sync: ${newCount} timezone override(s) set`;
  }

  const lines = [
    'TripIt → Reclaim Travel Timezone Sync',
    '═'.repeat(40),
    '',
    `Default timezone: ${defaultTimezone}`,
    '',
  ];

  if (prevCount > 0) {
    lines.push(`Cleared ${prevCount} previous entry/entries.`);
    lines.push('');
  }

  if (newCount === 0) {
    lines.push('No upcoming travel timezone overrides.');
  } else {
    lines.push('New timezone overrides:');
    lines.push('');
    for (const s of newSegments) {
      lines.push(`  ${s.timezone}`);
      lines.push(`    ${s.startDate} → ${s.endDate}`);
      lines.push(`    ${s.label}`);
      lines.push('');
    }
  }

  return { subject, message: lines.join('\n') };
}
