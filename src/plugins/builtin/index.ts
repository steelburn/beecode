import type { PluginDefinition } from '../types';
import { pdfGeneratorPlugin } from './pdfGenerator';
import { pdfViewerPlugin } from './pdfViewer';
import { tableExportPlugin } from './tableExport';

/**
 * Plugins shipped with the build. They go through exactly the same contract as a plugin
 * dropped into `~/.beecode/plugins` — dogfooding the API is what keeps it usable.
 */
export const BUILTIN_PLUGINS: PluginDefinition[] = [pdfViewerPlugin, pdfGeneratorPlugin, tableExportPlugin];
