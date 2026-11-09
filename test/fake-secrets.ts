// Fake secrets are assembled at run time so no realistic token appears literally
// in the repository (which would also trip GitHub push protection and scanners).
export const chars = (n: number, alphabet = 'aB3dE5gH7jK9mN1pQ') =>
  Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join('');
export const FAKE = {
  aws: 'AK' + 'IA' + chars(16, 'ABCDEFGHIJKLMNOP2345'),
  github: 'gh' + 'p_' + chars(36),
  slack: 'xo' + 'xb-' + chars(24),
  stripe: 'sk' + '_live_' + chars(24),
  anthropic: 'sk-' + 'ant-' + chars(32),
  openai: 'sk-' + 'proj-' + chars(32),
  google: 'AI' + 'za' + chars(35),
  sendgrid: 'SG' + '.' + chars(22) + '.' + chars(30),
  jwt: 'ey' + 'J' + chars(16) + '.' + 'ey' + 'J' + chars(16) + '.' + chars(20),
  bearer: chars(32),
  privateKey: '-----BEGIN ' + 'PRIVATE KEY-----\n' + chars(40) + '\n-----END ' + 'PRIVATE KEY-----',
};
