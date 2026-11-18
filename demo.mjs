/**
 * Run the tool without booting dsh — handy for trying it and for the README demo.
 *
 *   node demo.mjs
 *   node demo.mjs --command "python bench/accuracy.py"
 */
import { apply } from './lib/index.js'

const args = process.argv.slice(2)
const get = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

let definition = null
apply({ tools: { register: (def) => { definition = def } } }, {})

const result = await definition.execute({
  command: get('--command', 'node -e "setTimeout(()=>{},30)"'),
  description: 'demo run',
  label: get('--label', 'demo'),
  repeats: Number(get('--repeats', '5')),
  warmup: Number(get('--warmup', '1')),
})
console.log(result)
