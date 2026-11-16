import { PLATFORM_GAME_SUMMARY_SELECT } from './platform-game-summary.constant';

describe('PLATFORM_GAME_SUMMARY_SELECT', () => {
  it("serves the game's subtitle beside its title (#1271)", () => {
    expect(PLATFORM_GAME_SUMMARY_SELECT.game.select).toEqual({
      id: true,
      title: true,
      subtitle: true,
      thumbnail: true,
    });
  });
});
