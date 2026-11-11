# Aluetoo Mobile

Application web mobile d'Aluetoo AI (GitHub Pages) avec authentification Supabase et appels IA relayés par une Supabase Edge Function.

## Configuration Supabase déjà reliée

- Authentification e-mail/mot de passe via Supabase Auth.
- Connexion Google via Supabase Auth (le fournisseur Google doit être activé dans Authentication > Providers).
- Edge Function `aluetoo-chat` déployée avec vérification JWT activée.
- Quotas appliqués en base, pas dans le navigateur : Fast Lite 20, Super Fast 10, Pro 5 messages par fenêtre glissante de 6 heures.
- Les messages bonus `user_controls.bonus_messages` sont consommés par Fast Lite après le quota standard.
- Les bannissements `user_controls.is_banned` sont vérifiés avant chaque appel au fournisseur IA.

## Secret obligatoire avant d'utiliser le chat IA

Dans Supabase Dashboard → Edge Functions → Secrets, ajoute :

- `GROQ_API_KEY` = une nouvelle clé Groq créée après révocation de l'ancienne clé exposée dans l'ancien JavaScript.

Ne remets jamais l'ancienne clé dans le dépôt. Ne publie jamais une clé `service_role` ou `sb_secret_...`.

## Comptes existants

Les anciens comptes enregistrés uniquement dans le `localStorage` du navigateur ne sont pas des comptes Supabase Auth et leurs mots de passe ne peuvent pas être transférés automatiquement. Les utilisateurs devront créer un compte Supabase Auth avec leur adresse, puis confirmer leur e-mail si la confirmation est activée. Le compte administrateur déjà présent dans la table `profiles` est conservé.

## Google Sign-In

Dans Supabase Dashboard → Authentication → Providers → Google, configure le Client ID et le Client Secret Google OAuth. L'ID client Google déjà utilisé par le site doit être autorisé dans la configuration Google et dans les URLs de redirection Supabase.

## Limites et sécurité

- Le navigateur appelle uniquement `/functions/v1/aluetoo-chat`, jamais directement Groq.
- La clé Groq est lue uniquement par l'Edge Function via le secret `GROQ_API_KEY`.
- La fonction valide le JWT Supabase, applique les limites et vérifie les bannissements côté serveur.
- La table `aluetoo_ai_usage` est inaccessible à `anon` et `authenticated`; seule la fonction serveur consomme les quotas.
- Les historiques de conversations et préférences restent dans le stockage local du navigateur.
- Les fichiers joints sont actuellement indiqués dans le prompt par leur nom; leur contenu n'est pas encore envoyé au modèle.
