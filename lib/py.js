// renut_nx_ultimate_installer (from kameo-nx-installer, renut-nx-webinstaller): the ultimate base's own Python shader tools
// (py/: copies of its tools/deko3d_glsl.py, deko3d_glsl_opt.py with its shader lists, early_alpha.py and
// renut_early_alpha.py, made by tools/sync_from_base.py), run unchanged in Pyodide (vendor/pyodide, 0.27.7 core, with its
// numpy for early_alpha.py's self-check) so the page's GLSL is the native chain's.

export const PY_FILES = ['deko3d_glsl.py', 'deko3d_glsl_opt.py', 'gpr32_shaders.txt', 'lightbranch_shaders.txt',
                         'nullps_shaders.txt', 'skinonce_shaders.txt', 'early_alpha.py', 'renut_early_alpha.py'];

// loadPyodide: from vendor/pyodide/pyodide.mjs; readFile(name) -> Promise<string> (the page: fetch; Node: fs).
export async function loadPython(loadPyodide, indexURL, readFile) {
  const pyodide = await loadPyodide({ indexURL });
  await pyodide.loadPackage('numpy', { messageCallback: () => {} });
  pyodide.FS.mkdirTree('/py');
  for (const name of PY_FILES) pyodide.FS.writeFile('/py/' + name, await readFile(name));
  pyodide.runPython(`
import sys, os, io, shutil, contextlib
sys.path.insert(0, '/py')
import deko3d_glsl, deko3d_glsl_opt, renut_early_alpha
def _convert(text, stage):
    out, _ = deko3d_glsl.convert(text, stage, deko3d_glsl.DEFAULT_UBO_MAP, 'handle')
    return out
def _optimise(text, stage, name):
    return deko3d_glsl_opt.optimise(text, deko3d_glsl_opt.DEFAULT, stage, name)
def _early_alpha(items):
    # renut_early_alpha.py on a folder of the pixel shaders' HLSL, as the native build runs it (in place)
    d = '/ea/batch'
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    for n, t in items:
        with open(f'{d}/{n}.hlsl', 'w', encoding='utf-8', newline='') as f:
            f.write(t)
    sys.argv = ['renut_early_alpha.py', d, '--jobs', '1']
    with contextlib.redirect_stdout(io.StringIO()):
        renut_early_alpha.main()
    out = []
    for n, _ in items:
        with open(f'{d}/{n}.hlsl', encoding='utf-8', newline='') as f:
            out.append((n, f.read()))
    return out
`);
  const convert = pyodide.globals.get('_convert');
  const optimise = pyodide.globals.get('_optimise');
  const earlyAlpha = pyodide.globals.get('_early_alpha');
  return {
    pyodide,
    // SPIRV-Cross's Vulkan GLSL -> uam's GLSL (tools/deko3d_shaders.py's step); stage 'vert' or 'frag'
    convert: (text, stage) => convert(text, stage),
    // the default passes (glsl_opt_any of the native chain); name: the shader's 16 hex digits
    optimise: (text, stage, name) => optimise(text, stage, name),
    // [[name, hlsl]] -> [[name, rewritten hlsl]]
    earlyAlpha(items) {
      if (!items.length) return [];
      const r = earlyAlpha(items);
      const out = r.toJs();
      r.destroy();
      return out;
    },
  };
}
