const requireSigning = process.env.TSUKIORI_REQUIRE_CODE_SIGNING === '1';

module.exports = {
  appId: 'ai.tsukiori.desktop',
  productName: 'Tsukiori',
  artifactName: 'Tsukiori-${version}-${arch}-setup.${ext}',
  asar: true,
  asarUnpack: [
    'node_modules/@tsukiori/credential-broker/dist/windows/**',
    'dist/daemon/windows/**',
  ],
  directories: { output: 'release' },
  files: ['dist/**/*', 'package.json', '!dist/**/*.map'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    forceCodeSigning: requireSigning,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
    differentialPackage: true,
  },
  publish: null,
};