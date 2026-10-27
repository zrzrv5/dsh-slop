function quote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'` }

/** Bash-only helper: bounded, optional reporting preserves the workload's exit status. */
export function callbackScript(origin: string, runId: string, token: string): string {
  return [
    '# Place after #SBATCH/#PBS directives, before environment setup. Merge an existing EXIT trap explicitly.',
    `_dsh_queue_url=${quote(`${origin.replace(/\/$/u, '')}/queue/events`)}`,
    `_dsh_queue_token=${quote(token)}`,
    `_dsh_queue_run=${quote(runId)}`,
    '_dsh_queue_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    '_dsh_queue_sequence=0',
    '_dsh_queue_attempt=${SLURM_RESTART_COUNT:-0}',
    '_dsh_queue_job=${SLURM_JOB_ID:-${PBS_JOBID:-$$}}',
    'if [ -n "${SLURM_ARRAY_TASK_ID:-}" ]; then _dsh_queue_job="${SLURM_ARRAY_JOB_ID}_${SLURM_ARRAY_TASK_ID}"; fi',
    'dsh_queue_event() {',
    '  local kind="$1" extra="" stamp payload phase_pattern=\'^[a-zA-Z0-9 _.:-]{1,128}$\'',
    '  case "$kind" in',
    '    phase) [[ "${2:-}" =~ $phase_pattern ]] || return 0; extra=",\\"phase\\":\\"$2\\"" ;;',
    '    exited) [[ "${2:-}" =~ ^[0-9]{1,3}$ ]] || return 0; extra=",\\"exitCode\\":$2" ;;',
    '    started) ;;',
    '    *) return 0 ;;',
    '  esac',
    '  stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    '  _dsh_queue_sequence=$((_dsh_queue_sequence + 1))',
    '  printf -v payload \'{"runId":"%s","jobId":"%s","attempt":%s,"sequence":%s,"kind":"%s","occurredAt":"%s","startedAt":"%s"%s}\' "$_dsh_queue_run" "$_dsh_queue_job" "$_dsh_queue_attempt" "$_dsh_queue_sequence" "$kind" "$stamp" "$_dsh_queue_started" "$extra"',
    '  if command -v curl >/dev/null 2>&1; then',
    '    curl --silent --fail --connect-timeout 2 --max-time 4 --retry 1 --retry-max-time 8 --output /dev/null --header "Authorization: Bearer $_dsh_queue_token" --header "Content-Type: application/json" --data-binary "$payload" "$_dsh_queue_url" 2>/dev/null || :',
    '  fi',
    '  return 0',
    '}',
    'dsh_queue_event started',
    "trap '_dsh_queue_exit=$?; trap - EXIT; dsh_queue_event exited \"$_dsh_queue_exit\"; exit \"$_dsh_queue_exit\"' EXIT",
    '# Optional: dsh_queue_event phase "equilibration"',
  ].join('\n')
}
