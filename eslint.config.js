import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    files: ['**/*.rules'],
    plugins: {
      firebase: firebaseRulesPlugin,
    },
    rules: {
      // we can add rules if needed, but let's use the recommended config
    }
  },
  firebaseRulesPlugin.configs['flat/recommended']
];
