// The original document hash is pinned to release 1.0.201 (5c39213), before
// this additive Section 10 update. Tests must not depend on a Git checkout.
const PREVIOUS_TERMS_VERSION = '2026-11-10';
const PREVIOUS_TERMS_HASH = '722b81ed46916e177e397fbc8b8db3e90ce1b0c7d20e0c055e996e3083ad9d49';
const CURRENT_TERMS_VERSION = '2026-11-11';
const ORIGINAL_SECTION_TEN = [
  '10. Content; Intellectual Property',
  'You retain ownership of the Content you submit. By posting Content, you grant Silver Glider a worldwide, non-exclusive, royalty-free license to use, reproduce, display, and distribute such Content solely for operating, improving, and marketing the Platform and Events.',
  'Silver Glider owns all rights in and to the Platform, including software, branding, and design.'
].join('\n');
const ADDED_PARAGRAPHS = [
  'By submitting Content, including event flyers, photographs, logos, banners, and profile images, you represent and warrant that you own the Content or have obtained all rights, licenses, permissions, and consents necessary to upload, display, and share it through the Platform.',
  'You are responsible for the Content you submit and for ensuring that its use does not violate applicable laws or the rights of others, including copyright, trademark, privacy, and publicity rights.',
  'Silver Glider may review, restrict, disable access to, or remove Content that we reasonably believe violates these Terms, infringes the rights of others, or presents a legal or safety concern.',
  'Users and rights holders may report potentially infringing or prohibited Content through our designated reporting channels. We may investigate complaints and take appropriate action, including removal of Content and suspension of accounts. We maintain a policy for terminating repeat copyright infringers in appropriate circumstances.'
];
const ADDED_TEXT = `${ADDED_PARAGRAPHS.join('\n')}\n`;

module.exports = {
  PREVIOUS_TERMS_VERSION, PREVIOUS_TERMS_HASH, CURRENT_TERMS_VERSION,
  ORIGINAL_SECTION_TEN, ADDED_PARAGRAPHS, ADDED_TEXT
};
