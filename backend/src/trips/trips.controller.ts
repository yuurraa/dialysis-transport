import { Controller, Inject } from '@nestjs/common';
import { TripsService } from './trips.service';

/** UC-04, UC-05, UC-05.1 and UC-09 to UC-12: operations, recovery and patient actions. */
@Controller('trips')
export class TripsController {
  constructor(@Inject(TripsService) private readonly service: TripsService) {}
  // TODO: Add validated routes with account, role and patient-scope checks.
  // No business endpoints are exposed until these checks and SQL policies are implemented.
}
