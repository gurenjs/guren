// Findings `guren audit` reports but you have judged safe, each keyed by the
// finding's `key` (copy it from `guren audit --json`) and a reason. An entry
// that stops matching anything is reported, so delete it once it does.
export default {
  ignore: [
    {
      key: 'deps:picomatch:GHSA-FC5Q-39XC-VJPF',
      reason:
        'picomatch <=4.0.7 ReDoS needs an attacker-chosen glob pattern; Vite and its globbers '
        + 'here read patterns from configuration only, and no picomatch release is outside the range yet.',
    },
  ],
}
