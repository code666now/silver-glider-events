// Pin the pre-addition Privacy Policy from release 1.0.205 without requiring Git.
const PREVIOUS_PRIVACY_VERSION = '2026-11-10';
const PREVIOUS_PRIVACY_HASH = 'bb1155ad1cb8120a26372b09f8f2b384a2b66d952853b15e2f257f708e5430ea';
const CURRENT_PRIVACY_VERSION = '2026-11-14';
const ADDED_HEADING = "13. Children's Privacy";
const ADDED_PARAGRAPHS = [
  'Silver Glider Events is intended for users aged 18 and older and is not directed toward children under 13.',
  'We do not knowingly collect personal information directly from children under 13.',
  'If we discover that we have collected personal information from a child under 13 without legally sufficient parental consent or another applicable legal basis, we will take appropriate steps to delete that information as required by law.',
  'If you believe a child under 13 has provided personal information through our Platform, please contact us at support@silverglidertickets.com.'
];
const ADDED_TEXT = `${ADDED_HEADING}\n${ADDED_PARAGRAPHS.join('\n')}\n`;

module.exports = {
  PREVIOUS_PRIVACY_VERSION, PREVIOUS_PRIVACY_HASH, CURRENT_PRIVACY_VERSION,
  ADDED_HEADING, ADDED_PARAGRAPHS, ADDED_TEXT
};
