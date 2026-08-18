import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** worker 心跳上报 */
export class WorkerHeartbeatDto {
  @IsString()
  @IsNotEmpty()
  workerId!: string;

  @IsOptional()
  @IsString()
  nodeId?: string;
}
