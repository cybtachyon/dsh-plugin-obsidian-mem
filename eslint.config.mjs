// @ts-check

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Local rule: a `description` string that opens is-style ("is the KV data
 * type", "It is ...", "This is ...") describes what a thing is, not what it
 * does. The ParameterSpec descriptions the plan requires are behavior-first,
 * so the rule reports them and names the fix.
 */
const obsidianMem = {
    rules: {
        'behavior-first-description': {
            meta: {
                type: 'problem',
                docs: {
                    description:
                        'description strings must be behavior-first, not is-style',
                },
                messages: {
                    isStyle:
                        '"{{text}}" is an is-style description. Describe what the parameter does, not what it is.',
                },
                schema: [],
            },
            create(context) {
                return {
                    Property(node) {
                        const key = node.key;
                        const keyName =
                            key.type === 'Identifier'
                                ? key.name
                                : key.type === 'Literal'
                                  ? String(key.value)
                                  : null;
                        if (keyName !== 'description') {
                            return;
                        }
                        const value = node.value;
                        if (value.type !== 'Literal' || typeof value.value !== 'string') {
                            return;
                        }
                        // is-style openers: the copula leads, so the sentence
                        // names a thing instead of an effect.
                        if (/^\s*(is|it is|this is|are|was|were)\s/i.test(value.value)) {
                            context.report({
                                node: value,
                                messageId: 'isStyle',
                                data: { text: value.value },
                            });
                        }
                    },
                };
            },
        },
    },
};

export default defineConfig([
    {
        // The packages' lib/ trees are tsc output: lint the source, not the
        // build. dsh/client.js is the same kind of emit: scripts/build-client.mjs
        // generates it from packages/client/src, so lint the source tree, not
        // the artifact. (dsh/client.js does not exist yet: the scaffold skips
        // the bundle until the client card lands in TASK-051/052.)
        ignores: ['packages/*/lib/**', 'dsh/client.js'],
    },
    {
        files: ['**/*.{js,ts}'],
        extends: [js.configs.recommended, tseslint.configs.recommended],
        plugins: { 'obsidian-mem': obsidianMem },
        rules: {
            // Stub parameters in the scaffold are intentionally unused; the
            // leading underscore marks a placeholder a later phase fills in.
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            'obsidian-mem/behavior-first-description': 'error',
            // Every file ends with a newline. This front-loads the same check
            // the end-of-file-fixer pre-commit hook applies, so `pnpm lint`
            // reports a missing final newline before the commit barrier does.
            'eol-last': ['error', 'always'],
        },
    },
]);
