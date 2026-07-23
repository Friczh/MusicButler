export const commandDefinitions = [
  {
    name: 'play',
    description: 'Play a track',
    options: [
      { type: 3, name: 'query', description: 'URL or search query', required: true },
    ],
  },
  { name: 'skip', description: 'Skip current track' },
  { name: 'pause', description: 'Pause playback' },
  { name: 'resume', description: 'Resume playback' },
  { name: 'leave', description: 'Disconnect from voice channel' },
  {
    name: 'queue',
    description: 'View or manage the queue',
    options: [
      { type: 1, name: 'list', description: 'Show current queue' },
      {
        type: 1,
        name: 'remove',
        description: 'Remove a track from the queue',
        options: [
          { type: 4, name: 'position', description: 'Queue position (1 = next up)', required: true, min_value: 0 },
        ],
      },
      {
        type: 1,
        name: 'swap',
        description: 'Swap two tracks in the queue',
        options: [
          { type: 4, name: 'position_a', description: 'First position', required: true, min_value: 0 },
          { type: 4, name: 'position_b', description: 'Second position', required: true, min_value: 0 },
        ],
      },
      {
        type: 1,
        name: 'move',
        description: 'Move a track to a new position',
        options: [
          { type: 4, name: 'from', description: 'Current position', required: true, min_value: 0 },
          { type: 4, name: 'to', description: 'New position', required: true, min_value: 0 },
        ],
      },
      { type: 1, name: 'clear', description: 'Clear the entire queue' },
    ],
  },
];
