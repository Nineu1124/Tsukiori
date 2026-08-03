const requireSigning = process.env.TSUKIORI_REQUIRE_CODE_SIGNING === '1';

module.exports = {
  appId: 'ai.tsukiori.desktop',
  productName: 'Tsukiori',
  artifactName: 'Tsukiori-${version}-${arch}-setup.${ext}',
  asar: true,
  npmRebuild: false,
  asarUnpack: [
    'node_modules/node-pty/**',
    'node_modules/@tsukiori/credential-broker/dist/windows/**',
    'dist/daemon/windows/**',
  ],
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'package.json', '!dist/**/*.map'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
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
