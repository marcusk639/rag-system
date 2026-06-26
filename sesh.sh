GEMINI_API_KEY="$GEMINI_API_KEY" ./scripts/reembed-and-stream.sh


   

   
curl -s -H "x-goog-api-key: $GEMINI_API_KEY" "https://generativelanguage.googleapis.com/v1beta/models" \
  | grep -o '"name": "[^"]*"' | head -40
  













────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 4.8 (1M context) │ recovery-platform ██░░░░░░░░ 28%                                                Remote Control active
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents