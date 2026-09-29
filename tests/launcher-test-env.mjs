// Unit tests must not configure the developer's OS or pair real accounts.
// Real first-run tests use isolated profiles and explicitly enable installation.
process.env.DEVSPEC_LAUNCHER_DISABLED = '1';
