// @ts-check
import fs, { stat } from 'fs';
import prettier from 'prettier';
import ts from 'typescript';
import { get_bundled_types } from './compile-types.js';

/** @typedef {{ name: string; comment: string; markdown: string; }} Extracted */

/** @type {Array<{ name: string; comment: string; exports: Extracted[]; types: Extracted[]; exempt?: boolean; }>} */
const modules = [];

/**
 * @param {string} code
 * @param {ts.NodeArray<ts.Statement>} statements
 */
function get_types(code, statements) {
	/** @type {Extracted[]} */
	const exports = [];

	/** @type {Extracted[]} */
	const types = [];

	if (statements) {
		for (const statement of statements) {
			const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;

			const export_modifier = modifiers?.find((modifier) => modifier.kind === 93);
			if (!export_modifier) continue;

			if (
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isModuleDeclaration(statement) ||
				ts.isVariableStatement(statement) ||
				ts.isFunctionDeclaration(statement)
			) {
				const name_node = ts.isVariableStatement(statement)
					? statement.declarationList.declarations[0]
					: statement;

				// @ts-ignore no idea why it's complaining here
				const name = name_node.name?.escapedText;

				let start = statement.pos;
				let comment = '';

				// @ts-ignore i think typescript is bad at typescript
				if (statement.jsDoc) {
					// @ts-ignore
					comment = statement.jsDoc[0].comment;
					// @ts-ignore
					start = statement.jsDoc[0].end;
				}

				const i = code.indexOf('export', start);
				start = i + 6;

				/** @type {string[]} */
				const children = [];

				let snippet_unformatted = code.slice(start, statement.end).trim();

				if (ts.isInterfaceDeclaration(statement)) {
					if (statement.members.length > 0) {
						for (const member of statement.members) {
							children.push(munge_type_element(member));
						}

						// collapse `interface Foo {/* lots of stuff*/}` into `interface Foo {…}`
						const first = statement.members.at(0);
						const last = statement.members.at(-1);

						let body_start = first.pos - start;
						while (snippet_unformatted[body_start] !== '{') body_start -= 1;

						let body_end = last.end - start;
						while (snippet_unformatted[body_end] !== '}') body_end += 1;

						snippet_unformatted =
							snippet_unformatted.slice(0, body_start + 1) +
							'/*…*/' +
							snippet_unformatted.slice(body_end);
					}
				}

				const snippet = prettier
					.format(snippet_unformatted, {
						parser: 'typescript',
						printWidth: 80,
						useTabs: true,
						singleQuote: true,
						trailingComma: 'none'
					})
					.replace(/\s*(\/\*…\*\/)\s*/g, '/*…*/')
					.trim();

				const collection =
					ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement)
						? exports
						: types;

				collection.push({ name, comment, snippet, children });
			}
		}

		types.sort((a, b) => (a.name < b.name ? -1 : 1));
		exports.sort((a, b) => (a.name < b.name ? -1 : 1));
	}

	return { types, exports };
}

/**
 * @param {ts.TypeElement} member
 */
function munge_type_element(member, depth = 1) {
	// @ts-ignore
	const doc = member.jsDoc?.[0];

	/** @type {string} */
	const children = [];

	const name = member.name?.escapedText;
	let snippet = member.getText();

	for (let i = 0; i < depth; i += 1) {
		snippet = snippet.replace(/^\t/gm, '');
	}

	if (
		ts.isPropertySignature(member) &&
		ts.isTypeLiteralNode(member.type) &&
		member.type.members.some((member) => member.jsDoc?.[0].comment)
	) {
		let a = 0;
		while (snippet[a] !== '{') a += 1;

		snippet = snippet.slice(0, a + 1) + '/*…*/}';

		for (const child of member.type.members) {
			children.push(munge_type_element(child, depth + 1));
		}
	}

	/** @type {string[]} */
	const bullets = [];

	for (const tag of doc?.tags ?? []) {
		const type = tag.tagName.escapedText;

		switch (tag.tagName.escapedText) {
			case 'param':
				bullets.push(`- \`${tag.name.getText()}\` ${tag.comment}`);
				break;

			case 'default':
				bullets.push(`- <span class="tag">default</span> \`${tag.comment}\``);
				break;

			case 'returns':
				bullets.push(`- <span class="tag">returns</span> ${tag.comment}`);
				break;

			default:
				console.log(`unhandled JSDoc tag: ${type}`); // TODO indicate deprecated stuff
		}
	}

	return {
		name,
		snippet,
		comment: (doc?.comment ?? '')
			.replace(/\/\/\/ type: (.+)/g, '/** @type {$1} */')
			.replace(/^(  )+/gm, (match, spaces) => {
				return '\t'.repeat(match.length / 2);
			}),
		bullets,
		children
	};
}

/**
 * Type declarations include fully qualified URLs so that they become links when
 * you hover over names in an editor with TypeScript enabled. We need to remove
 * the origin so that they become root-relative, so that they work in preview
 * deployments and when developing locally
 * @param {string} str
 */
function strip_origin(str) {
	return str.replace(/https:\/\/svelte\.dev/g, '');
}

/**
 * @param {string} str
 */
function read_d_ts_file(str) {
	// We can't use JSDoc comments inside JSDoc, so we would get ts(7031) errors if
	// we didn't ignore this error specifically for `/// file:` code examples
	return str.replace(
		/(\s*\*\s*)\/\/\/ file:/g,
		(match, prefix) => prefix + '// @errors: 7031' + match
	);
}

const bundled_types = await get_bundled_types();

// {
// 	const code = bundled_types.get('svelte/compiler') ?? '';
// 	const node = ts.createSourceFile('compiler/index.d.ts', code, ts.ScriptTarget.Latest, true);

// 	modules.push({
// 		name: 'svelte/compiler',
// 		comment: '',
// 		...get_types(code, node.statements)
// 	});
// }

{
	const code = bundled_types.get('svelte/runtime') ?? '';
	const node = ts.createSourceFile('runtime/index.d.ts', code, ts.ScriptTarget.Latest, true);

	modules.push({
		name: 'svelte',
		comment: '',
		...get_types(code, node.statements)
	});
}

{
	const code = bundled_types.get('svelte/action') ?? '';
	const node = ts.createSourceFile('runtime/action/index.d.ts', code, ts.ScriptTarget.Latest, true);

	modules.push({
		name: 'svelte/action',
		comment: '',
		...get_types(code, node.statements)
	});
}

{
	const code = bundled_types.get('svelte/animate') ?? '';
	const node = ts.createSourceFile(
		'runtime/animate/index.d.ts',
		code,
		ts.ScriptTarget.Latest,
		true
	);

	modules.push({
		name: 'svelte/animate',
		comment: '',
		...get_types(code, node.statements)
	});
}

{
	const code = bundled_types.get('svelte/easing') ?? '';
	const node = ts.createSourceFile('runtime/easing/index.d.ts', code, ts.ScriptTarget.Latest, true);

	modules.push({
		name: 'svelte/easing',
		comment: '',
		...get_types(code, node.statements)
	});
}

{
	const code = bundled_types.get('svelte/motion') ?? '';
	const node = ts.createSourceFile('runtime/motion/index.d.ts', code, ts.ScriptTarget.Latest, true);

	modules.push({
		name: 'svelte/motion',
		comment: '',
		...get_types(code, node.statements)
	});
}

{
	const code = bundled_types.get('svelte/store') ?? '';
	const node = ts.createSourceFile('runtime/store/index.d.ts', code, ts.ScriptTarget.Latest, true);

	modules.push({
		name: 'svelte/store',
		comment: '',
		...get_types(code, node.statements)
	});
}

{
	const code = bundled_types.get('svelte/transition') ?? '';
	const node = ts.createSourceFile(
		'runtime/transition/index.d.ts',
		code,
		ts.ScriptTarget.Latest,
		true
	);

	modules.push({
		name: 'svelte/transition',
		comment: '',
		...get_types(code, node.statements)
	});
}

{
	const code = bundled_types.get('svelte/internal') ?? '';
	const node = ts.createSourceFile(
		'runtime/internal/index.d.ts',
		code,
		ts.ScriptTarget.Latest,
		true
	);

	modules.push({
		name: 'svelte/internal',
		comment: '',
		...get_types(code, node.statements)
	});
}

// const dir = fileURLToPath(
// 	new URL('../../../../packages/kit/types/synthetic', import.meta.url).href
// );
// for (const file of fs.readdirSync(dir)) {
// 	if (!file.endsWith('.md')) continue;

// 	const comment = strip_origin(read_d_ts_file(`${dir}/${file}`));

// 	modules.push({
// 		name: file.replace(/\+/g, '/').slice(0, -3),
// 		comment,
// 		exports: [],
// 		types: [],
// 		exempt: true
// 	});
// }

{
	const code = read_d_ts_file('types/ambient.d.ts');
	const node = ts.createSourceFile('ambient.d.ts', code, ts.ScriptTarget.Latest, true);

	for (const statement of node.statements) {
		if (ts.isModuleDeclaration(statement)) {
			// @ts-ignore
			const name = statement.name.text || statement.name.escapedText;

			// @ts-ignore
			const comment = strip_origin(statement.jsDoc?.[0].comment ?? '');

			modules.push({
				name,
				comment,
				// @ts-ignore
				...get_types(code, statement.body?.statements)
			});
		}
	}
}

modules.sort((a, b) => (a.name < b.name ? -1 : 1));

fs.writeFileSync(
	new URL('../../src/lib/server/docs/type-info.js', import.meta.url),
	`
/* This file is generated by running \`node scripts/extract-types.js\`
   in the packages/kit directory — do not edit it */
export const modules = ${JSON.stringify(modules, null, '  ')};
`.trim()
);
